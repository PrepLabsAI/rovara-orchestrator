import { App } from "aws-cdk-lib";
import { describe, expect, test } from "vitest";
import { jsonContext } from "../lib/context.js";

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
