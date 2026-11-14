import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { BuildSpec, Cache, ComputeType, LinuxArmBuildImage, LocalCacheMode, PipelineProject } from "aws-cdk-lib/aws-codebuild";
import { Artifact, ExecutionMode, Pipeline, PipelineType } from "aws-cdk-lib/aws-codepipeline";
import { CodeBuildAction, CodeStarConnectionsSourceAction } from "aws-cdk-lib/aws-codepipeline-actions";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import type { StageConfig } from "./stage.js";

export interface PipelineStackProps extends StackProps {
  /** The stage every push deploys. */
  stage: StageConfig;
  /** An authorized CodeConnections GitHub connection that can read `repository`. */
  connectionArn: string;
  /** `owner/name` on GitHub. */
  repository: string;
  branch: string;
}

const NODE_VERSION = "22.19.0";
const DYNAMODB_LOCAL_IMAGE = "public.ecr.aws/aws-dynamodb-local/aws-dynamodb-local:latest";
/** Tests talk only to DynamoDB Local, with credentials that real AWS refuses. */
const TEST_ENV = "AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local DYNAMODB_ENDPOINT=http://localhost:8000";
const SUITES = ["npm test", "npm run test:contract", "npm run test:integration", "npm run test:fault"];

/**
 * Deploys one stage on every push to the branch: runs every check CI runs, then `npm run deploy`
 * with the stage's settings from cdk.json, then rebuilds the status page against the stage's API.
 * The pipeline does not deploy itself; it is deployed by hand (runbook, "Deploy pipeline").
 */
export class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    if (props.stage.prod) throw new Error("the deploy pipeline cannot target prod: prod refuses the development sign-in until Rovara#442");
    super(scope, id, props);
    const stage = props.stage.name;
    const [owner, repo] = props.repository.split("/");
    if (!owner || !repo) throw new Error(`repository must be owner/name, got "${props.repository}"`);
    const serviceStack = `RovaraOrch-${stage}-Service`;
    const deploy = `npm run deploy -- -c stage=${stage} --require-approval never`;
    const readApiUrl = `api_url="$(aws cloudformation describe-stacks --stack-name ${serviceStack} --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text 2>/dev/null || true)"`;

    const logGroup = new LogGroup(this, "BuildLogs", { retention: RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY });
    const project = new PipelineProject(this, "Deploy", {
      projectName: `rovara-orch-${stage}-deploy`,
      description: `Tests and deploys the rovara-orchestrator ${stage} stage`,
      environment: { buildImage: LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0, computeType: ComputeType.MEDIUM, privileged: true },
      concurrentBuildLimit: 1,
      timeout: Duration.minutes(60),
      cache: Cache.local(LocalCacheMode.DOCKER_LAYER),
      logging: { cloudWatch: { logGroup } },
      buildSpec: BuildSpec.fromObject({
        version: "0.2",
        env: { shell: "bash" },
        phases: {
          install: {
            commands: [
              `node_archive="node-v${NODE_VERSION}-linux-arm64.tar.xz"`,
              `curl -fsSL -o "/tmp/\${node_archive}" "https://nodejs.org/dist/v${NODE_VERSION}/\${node_archive}"`,
              `curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" | grep " \${node_archive}$" | (cd /tmp && sha256sum -c -)`,
              `mkdir -p /opt/node && tar -xJf "/tmp/\${node_archive}" -C /opt/node --strip-components=1`,
              'export PATH="/opt/node/bin:$PATH"',
              "node --version && npm --version && aws --version",
            ],
          },
          pre_build: {
            commands: [
              "npm ci",
              `docker run -d --rm -p 8000:8000 --name dynamodb-local ${DYNAMODB_LOCAL_IMAGE} -jar DynamoDBLocal.jar -inMemory -sharedDb`,
              "for i in $(seq 1 30); do curl -s -o /dev/null http://localhost:8000 && break; sleep 1; done",
            ],
          },
          build: {
            commands: [
              "npm run lint",
              "npm run typecheck",
              ...SUITES.map((suite) => `env ${TEST_ENV} ${suite}`),
              // The status page is built against the API's URL, which exists only after the first deploy.
              readApiUrl,
              `if [ -z "$api_url" ] || [ "$api_url" = "None" ]; then ${deploy}; ${readApiUrl}; fi`,
              'VITE_API_URL="$api_url" npm run -w packages/web build',
              deploy,
            ],
          },
        },
      }),
    });

    const scoped = (service: string, resource: string): string => `arn:${this.partition}:${service}:${this.region}:${this.account}:${resource}`;
    project.addToRolePolicy(new PolicyStatement({
      sid: "AssumeCdkBootstrapRoles",
      actions: ["sts:AssumeRole"],
      resources: [`arn:${this.partition}:iam::${this.account}:role/cdk-hnb659fds-*-${this.account}-${this.region}`],
    }));
    project.addToRolePolicy(new PolicyStatement({
      sid: "ReadStageStacks",
      actions: ["cloudformation:DescribeStacks"],
      resources: [scoped("cloudformation", `stack/RovaraOrch-${stage}-*/*`)],
    }));

    const artifactBucket = new Bucket(this, "Artifacts", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(30) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const source = new Artifact("Source");
    new Pipeline(this, "Pipeline", {
      pipelineName: `RovaraOrch-${stage}-Deploy`,
      pipelineType: PipelineType.V2,
      // Each push is deployed on its own, in order, so a failure points at one change.
      executionMode: ExecutionMode.QUEUED,
      artifactBucket,
      crossAccountKeys: false,
      restartExecutionOnUpdate: false,
      stages: [
        { stageName: "Source", actions: [new CodeStarConnectionsSourceAction({ actionName: "GitHub", connectionArn: props.connectionArn, owner, repo, branch: props.branch, output: source })] },
        { stageName: "Deploy", actions: [new CodeBuildAction({ actionName: `Deploy-${stage}`, project, input: source })] },
      ],
    });
  }
}
