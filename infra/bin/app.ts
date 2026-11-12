import { App } from "aws-cdk-lib";
import { DataStack } from "../lib/data.js";
import { ServiceStack } from "../lib/service.js";
import { stageConfig } from "../lib/stage.js";
import { LoadStageStack } from "../lib/load-stage.js";
import { WebStack } from "../lib/web.js";

const app = new App();
const stage = stageConfig(String(app.node.tryGetContext("stage") ?? "test"));
const web = new WebStack(app, `RovaraOrch-${stage.name}-Web`, { stage });
const data = new DataStack(app, `RovaraOrch-${stage.name}-Data`, { stage });
// The load stage swaps Rovara and GitHub for fakes (T121); no other stage can.
const load = stage.name === "load" ? new LoadStageStack(app, `RovaraOrch-${stage.name}-Fakes`, { stage, secrets: data.secrets }) : undefined;
new ServiceStack(app, `RovaraOrch-${stage.name}-Service`, {
  stage,
  data,
  rovara: app.node.tryGetContext("rovara"),
  statusPageUrl: app.node.tryGetContext("statusPageUrl") ?? web.origin,
  pageOrigin: web.origin,
  github: app.node.tryGetContext("github"),
  ...(load ? { fakeServicesUrl: load.url, fakeServicesSecret: load.secret } : {}),
});
app.synth();
