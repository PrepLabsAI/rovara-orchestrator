import { fileURLToPath } from "node:url";
import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import { HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime, StartingPosition, FilterCriteria, FilterRule } from "aws-cdk-lib/aws-lambda";
import { DynamoEventSource, SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { DeduplicationScope, FifoThroughputLimit, Queue } from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import type { DataStack } from "./data.js";
import type { StageConfig } from "./stage.js";

export interface ServiceStackProps extends StackProps {
  stage: StageConfig;
  data: DataStack;
  /** Rovara deployment the orchestrator is an adapter of. */
  rovara?: { url: string; channel: string; tenant: string; space: string };
  statusPageUrl?: string;
  /** Bedrock model the answerer uses (research R8). */
  modelId?: string;
}

const handlers = fileURLToPath(new URL("../../packages/workers/src/lambda/handlers.ts", import.meta.url));
const apiEntry = fileURLToPath(new URL("../../packages/workers/src/lambda/api.ts", import.meta.url));

/** The HTTP API, the work queue and the six functions, one least-privilege role each (plan, research R2). */
export class ServiceStack extends Stack {
  readonly api: HttpApi;
  readonly queue: Queue;

  constructor(scope: Construct, id: string, props: ServiceStackProps) {
    super(scope, id, props);
    const { data, stage } = props;
    const rovara = props.rovara ?? { url: "https://rovara.invalid", channel: "orchestrator", tenant: stage.name, space: "mono" };

    const dlq = new Queue(this, "WorkDlq", { fifo: true, retentionPeriod: Duration.days(14) });
    this.queue = new Queue(this, "Work", {
      fifo: true,
      fifoThroughputLimit: FifoThroughputLimit.PER_MESSAGE_GROUP_ID,
      deduplicationScope: DeduplicationScope.MESSAGE_GROUP,
      visibilityTimeout: Duration.seconds(180),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
    });

    const environment = {
      STAGE: stage.name,
      TABLE_NAME: data.table.tableName,
      QUEUE_URL: this.queue.queueUrl,
      ROVARA_URL: rovara.url,
      ROVARA_CHANNEL: rovara.channel,
      ROVARA_TENANT: rovara.tenant,
      ROVARA_SPACE: rovara.space,
      STATUS_PAGE_URL: props.statusPageUrl ?? "https://status.invalid",
      MODEL_ID: props.modelId ?? "anthropic.claude-opus-5-5",
      ROVARA_SECRET_ARN: data.secrets.rovaraAdapterSecret.secretArn,
      GITHUB_APP_KEY_ARN: data.secrets.githubAppPrivateKey.secretArn,
      GITHUB_WEBHOOK_SECRET_ARN: data.secrets.githubWebhookSecret.secretArn,
      SLACK_TOKEN_ARN: data.secrets.slackToken.secretArn,
      NODE_OPTIONS: "--enable-source-maps",
    };
    const fn = (role: string, entry: string, handler: string, timeout = 30) =>
      new NodejsFunction(this, `Fn-${role}`, {
        entry,
        handler,
        runtime: Runtime.NODEJS_22_X,
        architecture: Architecture.ARM_64,
        memorySize: 512,
        timeout: Duration.seconds(timeout),
        environment: { ...environment, ROVARA_ORCH_ROLE: role },
        bundling: { format: undefined, sourceMap: true, target: "node22" },
      });

    const rovaraIngress = fn("rovara-ingress", handlers, "rovaraIngress");
    const githubIngress = fn("github-ingress", handlers, "githubIngress");
    const api = fn("api", apiEntry, "api");
    const consumer = fn("work-consumer", handlers, "workConsumer", 150);
    const intentRunner = fn("intent-runner", handlers, "intentRunner", 300);
    const sweep = fn("sweep", handlers, "sweep", 120);

    // Least privilege: data access per function, secrets only where used.
    for (const f of [rovaraIngress, githubIngress, api, consumer, intentRunner, sweep]) data.table.grantReadWriteData(f);
    data.secrets.rovaraAdapterSecret.grantRead(rovaraIngress);
    data.secrets.rovaraAdapterSecret.grantRead(api);
    data.secrets.rovaraAdapterSecret.grantRead(intentRunner);
    data.secrets.rovaraAdapterSecret.grantRead(sweep);
    data.secrets.githubWebhookSecret.grantRead(githubIngress);
    for (const f of [githubIngress, api, consumer, intentRunner, sweep]) data.secrets.githubAppPrivateKey.grantRead(f);
    data.secrets.slackToken.grantRead(intentRunner);
    data.secrets.slackToken.grantRead(sweep);
    api.addToRolePolicy(new PolicyStatement({ actions: ["s3:GetObject", "s3:PutObject"], resources: [data.dagBucket.arnForObjects("*")] }));
    api.addEnvironment("DAG_BUCKET", data.dagBucket.bucketName);
    this.queue.grantSendMessages(intentRunner);
    this.queue.grantSendMessages(sweep);
    for (const f of [intentRunner, sweep]) {
      f.addToRolePolicy(
        new PolicyStatement({
          actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
          resources: [`arn:${this.partition}:bedrock:${this.region}::foundation-model/${environment.MODEL_ID}`, `arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/*`],
        }),
      );
    }

    consumer.addEventSource(new SqsEventSource(this.queue, { batchSize: 10, reportBatchItemFailures: true }));
    intentRunner.addEventSource(
      new DynamoEventSource(data.table, {
        startingPosition: StartingPosition.LATEST,
        batchSize: 100,
        retryAttempts: 3,
        bisectBatchOnError: true,
        filters: [FilterCriteria.filter({ dynamodb: { NewImage: { entityType: { S: FilterRule.isEqual("INTENT") }, status: { S: FilterRule.isEqual("pending") } } } })],
      }),
    );
    new Rule(this, "SweepEveryMinute", { schedule: Schedule.rate(Duration.minutes(1)), targets: [new LambdaFunction(sweep)] });

    this.api = new HttpApi(this, "Api", { apiName: `rovara-orch-${stage.name}` });
    this.api.addRoutes({ path: "/rovara/events", methods: [HttpMethod.POST], integration: new HttpLambdaIntegration("RovaraEvents", rovaraIngress) });
    this.api.addRoutes({ path: "/github/events", methods: [HttpMethod.POST], integration: new HttpLambdaIntegration("GithubEvents", githubIngress) });
    this.api.addRoutes({ path: "/v1/{proxy+}", methods: [HttpMethod.ANY], integration: new HttpLambdaIntegration("OperatorApi", api) });
  }
}
