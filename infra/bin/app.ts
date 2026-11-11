import { App } from "aws-cdk-lib";
import { DataStack } from "../lib/data.js";
import { ServiceStack } from "../lib/service.js";
import { stageConfig } from "../lib/stage.js";

const app = new App();
const stage = stageConfig(String(app.node.tryGetContext("stage") ?? "test"));
const data = new DataStack(app, `RovaraOrch-${stage.name}-Data`, { stage });
new ServiceStack(app, `RovaraOrch-${stage.name}-Service`, {
  stage,
  data,
  rovara: app.node.tryGetContext("rovara"),
  statusPageUrl: app.node.tryGetContext("statusPageUrl"),
});
app.synth();
