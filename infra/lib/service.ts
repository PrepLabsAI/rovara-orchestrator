import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { CorsHttpMethod, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime, StartingPosition, FilterCriteria, FilterRule } from "aws-cdk-lib/aws-lambda";
import { DynamoEventSource, SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { DeduplicationScope, FifoThroughputLimit, Queue } from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import { addAlarms } from "./alarms.js";
import type { DataStack } from "./data.js";
import type { StageConfig } from "./stage.js";

export interface ServiceStackProps extends StackProps {
  stage: StageConfig;
  data: DataStack;
  /** Rovara deployment the orchestrator is an adapter of. */
  rovara?: { url: string; channel: string; tenant: string; space: string };
  statusPageUrl?: string;
  /** The status page's origin (WebStack.origin): the only origin the API allows, for its GET routes. */
  pageOrigin?: string;
  /** Load stage only: the fake services' URL and shared secret (LoadStageStack). */
  fakeServicesUrl?: string;
  fakeServicesSecret?: string;
  /** Development-only operators (until Rovara#442), for the API's sign-in; refused in prod. */
  devOperators?: Array<{ id: string; name: string; admin: boolean }>;
  /** The orchestrator's GitHub App (app id and installation id; the private key is in the secret store). */
  github?: { appId: string; installationId: string };
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
    if (props.fakeServicesUrl && props.stage.name !== "load") throw new Error(`fake services can be used only in the load stage, not in ${props.stage.name}`);
    if (props.devOperators?.length && props.stage.prod) throw new Error("development operators are not allowed in prod (Rovara#442 replaces them)");
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
      GITHUB_APP_ID: props.github?.appId ?? "",
      GITHUB_INSTALLATION_ID: props.github?.installationId ?? "",
      ...(props.fakeServicesUrl ? { FAKE_SERVICES_URL: props.fakeServicesUrl, FAKE_SERVICES_SECRET: props.fakeServicesSecret ?? "" } : {}),
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
        logGroup: new LogGroup(this, `Logs-${role}`, { retention: RetentionDays.ONE_MONTH, removalPolicy: stage.prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY }),
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
    if (props.devOperators?.length) api.addEnvironment("DEV_OPERATORS", JSON.stringify(props.devOperators));
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

    this.api = new HttpApi(this, "Api", {
      apiName: `rovara-orch-${stage.name}`,
      ...(props.pageOrigin
        ? { corsPreflight: { allowOrigins: [props.pageOrigin], allowMethods: [CorsHttpMethod.GET], allowHeaders: ["authorization"] } }
        : {}),
    });
    this.api.addRoutes({ path: "/rovara/events", methods: [HttpMethod.POST], integration: new HttpLambdaIntegration("RovaraEvents", rovaraIngress) });
    this.api.addRoutes({ path: "/github/events", methods: [HttpMethod.POST], integration: new HttpLambdaIntegration("GithubEvents", githubIngress) });
    this.api.addRoutes({ path: "/v1/{proxy+}", methods: [HttpMethod.ANY], integration: new HttpLambdaIntegration("OperatorApi", api) });

    addAlarms(this, { stage, api: this.api, dlq, consumer, intentRunner, sweep });
    new CfnOutput(this, "ApiUrl", { value: this.api.apiEndpoint, description: "rovara-orch --url; the Rovara adapter's callback is <ApiUrl>/rovara/events" });
    new CfnOutput(this, "TableName", { value: data.table.tableName });
    new CfnOutput(this, "WorkConsumerLogGroup", { value: consumer.logGroup.logGroupName });
  }
}
