import { App } from "aws-cdk-lib";
import { describe, expect, test } from "vitest";
import { jsonContext, stageContext } from "../lib/context.js";

describe("deploy context", () => {
  test("a JSON value given on the command line (-c key='{...}') is parsed", () => {
    const app = new App({ context: { rovara: '{"url":"https://r","tenant":"t"}', ops: '[{"id":"a"}]' } });
    expect(jsonContext(app, "rovara")).toEqual({ url: "https://r", tenant: "t" });
    expect(jsonContext(app, "ops")).toEqual([{ id: "a" }]);
  });

  test("an object from cdk.json is returned as is, and a missing key is undefined", () => {
    const app = new App({ context: { github: { appId: "1" } } });
    expect(jsonContext(app, "github")).toEqual({ appId: "1" });
    expect(jsonContext(app, "nope")).toBeUndefined();
  });

  test("a value that is not valid JSON is refused with the key's name", () => {
    const app = new App({ context: { rovara: "{url:" } });
    expect(() => jsonContext(app, "rovara")).toThrow(/rovara/);
  });
});

describe("stage settings", () => {
  const stages = { test: { rovara: { url: "https://placeholder" }, github: { appId: "0" } } };

  test("a setting comes from the stage's block in cdk.json", () => {
    const app = new App({ context: { stages } });
    expect(stageContext(app, "test", "rovara")).toEqual({ url: "https://placeholder" });
    expect(stageContext(app, "test", "github")).toEqual({ appId: "0" });
  });

  test("a -c value on the command line wins over the stage's block", () => {
    const app = new App({ context: { stages, rovara: '{"url":"https://override"}' } });
    expect(stageContext(app, "test", "rovara")).toEqual({ url: "https://override" });
  });

  test("another stage does not see the test stage's settings", () => {
    const app = new App({ context: { stages } });
    expect(stageContext(app, "load", "rovara")).toBeUndefined();
    expect(stageContext(new App(), "test", "rovara")).toBeUndefined();
  });
});
