import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import { Architecture, FunctionUrlAuthType, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import type { Construct } from "constructs";
import type { OrchestratorSecrets } from "./secrets.js";
import type { StageConfig } from "./stage.js";

export interface LoadStageProps extends StackProps {
  stage: StageConfig;
  /** The secrets the orchestrator verifies Rovara events and GitHub webhooks with; the fakes sign with them. */
  secrets?: OrchestratorSecrets;
}

const entry = fileURLToPath(new URL("../../packages/testkit/src/lambda/fake-services.ts", import.meta.url));

/**
 * The load stage's fake Rovara and fake GitHub (T121): one Lambda behind a function URL. Its state
 * lives in one warm container, so its reserved concurrency is 1. It can be deployed only in the
 * `load` stage. The load driver tells it the orchestrator's URL when a test starts, which keeps
 * the two stacks free of a circular reference.
 */
export class LoadStageStack extends Stack {
  readonly url: string;
  /** Shared by the workers and the fakes; a load-stage value, regenerated on every synth. */
  readonly secret: string;

  constructor(scope: Construct, id: string, props: LoadStageProps) {
    if (props.stage.name !== "load") throw new Error(`the fake services can be deployed only in the load stage, not in ${props.stage.name}`);
    super(scope, id, props);
    this.secret = randomUUID();
    const fn = new NodejsFunction(this, "FakeServices", {
      entry,
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 2048,
      timeout: Duration.seconds(60),
      reservedConcurrentExecutions: 1,
      environment: {
        FAKE_SERVICES_SECRET: this.secret,
        FAKE_REPO: "acme/mono",
        ...(props.secrets ? { ROVARA_SECRET_ARN: props.secrets.rovaraAdapterSecret.secretArn, GITHUB_WEBHOOK_SECRET_ARN: props.secrets.githubWebhookSecret.secretArn } : {}),
      },
    });
    props.secrets?.rovaraAdapterSecret.grantRead(fn);
    props.secrets?.githubWebhookSecret.grantRead(fn);
    this.url = fn.addFunctionUrl({ authType: FunctionUrlAuthType.NONE }).url;
    new CfnOutput(this, "FakeServicesUrl", { value: this.url });
  }
}
