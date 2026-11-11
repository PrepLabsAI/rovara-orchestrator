import { App } from "aws-cdk-lib";
import { stageConfig } from "../lib/stage.js";

const app = new App();
const stage = stageConfig(String(app.node.tryGetContext("stage") ?? "test"));
// Stacks are added by the data and service tasks; the stage decides their names and guards.
app.node.setContext("rovara-orch:stage", stage.name);
app.synth();
