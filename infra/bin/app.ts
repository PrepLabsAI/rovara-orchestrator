import { App } from "aws-cdk-lib";
import { DataStack } from "../lib/data.js";
import { ServiceStack } from "../lib/service.js";
import { stageConfig } from "../lib/stage.js";
import { LoadStageStack } from "../lib/load-stage.js";
import { WebStack } from "../lib/web.js";
import { jsonContext, stageContext } from "../lib/context.js";
import { PipelineStack } from "../lib/pipeline.js";

const app = new App();
const stage = stageConfig(String(app.node.tryGetContext("stage") ?? "test"));
const web = new WebStack(app, `RovaraOrch-${stage.name}-Web`, { stage });
const data = new DataStack(app, `RovaraOrch-${stage.name}-Data`, { stage });
// The load stage swaps Rovara and GitHub for fakes (T121); no other stage can.
const load = stage.name === "load" ? new LoadStageStack(app, `RovaraOrch-${stage.name}-Fakes`, { stage, secrets: data.secrets }) : undefined;
new ServiceStack(app, `RovaraOrch-${stage.name}-Service`, {
  stage,
  data,
  rovara: stageContext(app, stage.name, "rovara"),
  statusPageUrl: app.node.tryGetContext("statusPageUrl") ?? web.origin,
  pageOrigin: web.origin,
  github: stageContext(app, stage.name, "github"),
  devOperators: stageContext(app, stage.name, "devOperators"),
  ...(load ? { fakeServicesUrl: load.url, fakeServicesSecret: load.secret } : {}),
});
// Only when asked for (-c pipeline='{...}'), so the pipeline's own `cdk deploy --all` never redeploys the pipeline.
const pipeline = jsonContext<{ connectionArn: string; repository: string; branch: string }>(app, "pipeline");
if (pipeline) {
  new PipelineStack(app, `RovaraOrch-${stage.name}-Pipeline`, {
    stage,
    ...pipeline,
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  });
}
app.synth();
