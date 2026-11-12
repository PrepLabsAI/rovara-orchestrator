import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, test } from "vitest";
import { DataStack } from "../lib/data.js";
import { LoadStageStack } from "../lib/load-stage.js";
import { ServiceStack } from "../lib/service.js";
import { stageConfig } from "../lib/stage.js";

const app = () => new App({ context: { "aws:cdk:bundling-stacks": [] } });

describe("the load stage (T117)", () => {
  test.each(["prod", "test"])("cannot be deployed in the %s stage", (name) => {
    expect(() => new LoadStageStack(app(), "Load", { stage: stageConfig(name) })).toThrow(/only in the load stage/);
  });

  test("in the load stage: the fake services as one Lambda with a function URL, and the service stack pointed at it", () => {
    const a = app();
    const stage = stageConfig("load");
    const data = new DataStack(a, "Data", { stage });
    const load = new LoadStageStack(a, "Load", { stage, secrets: data.secrets });
    const service = new ServiceStack(a, "Service", { stage, data, fakeServicesUrl: load.url });
    const lt = Template.fromStack(load);
    lt.resourceCountIs("AWS::Lambda::Url", 1);
    lt.hasResourceProperties("AWS::Lambda::Function", { ReservedConcurrentExecutions: 1 });
    const fns = Object.values(Template.fromStack(service).findResources("AWS::Lambda::Function")) as Array<{ Properties: { Environment?: { Variables?: Record<string, unknown> } } }>;
    expect(fns.every((f) => f.Properties.Environment?.Variables?.FAKE_SERVICES_URL !== undefined)).toBe(true);
  });

  test("the service stack refuses a fake services URL outside the load stage", () => {
    const a = app();
    const stage = stageConfig("prod");
    const data = new DataStack(a, "Data", { stage });
    expect(() => new ServiceStack(a, "Service", { stage, data, fakeServicesUrl: "https://fakes.test" })).toThrow(/only in the load stage/);
  });
});
