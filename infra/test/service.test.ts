import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, test } from "vitest";
import { DataStack } from "../lib/data.js";
import { ServiceStack } from "../lib/service.js";
import { stageConfig } from "../lib/stage.js";

function template() {
  // Skip esbuild bundling in tests.
  const app = new App({ context: { "aws:cdk:bundling-stacks": [] } });
  const stage = stageConfig("test");
  const data = new DataStack(app, "Data", { stage });
  return Template.fromStack(new ServiceStack(app, "Service", { stage, data }));
}

type Statement = { Action: string | string[] };

describe("ServiceStack", () => {
  test("the HTTP API has the Rovara, GitHub and operator routes", () => {
    const t = template();
    const keys = Object.values(t.findResources("AWS::ApiGatewayV2::Route")).map((r) => (r as { Properties: { RouteKey: string } }).Properties.RouteKey);
    expect(keys.sort()).toEqual(["ANY /v1/{proxy+}", "POST /github/events", "POST /rovara/events"]);
  });

  test("the work queue is FIFO in high-throughput mode, with a FIFO dead-letter queue", () => {
    const t = template();
    t.hasResourceProperties("AWS::SQS::Queue", {
      FifoQueue: true,
      FifoThroughputLimit: "perMessageGroupId",
      DeduplicationScope: "messageGroup",
      RedrivePolicy: { maxReceiveCount: 5 },
    });
    expect(Object.keys(t.findResources("AWS::SQS::Queue"))).toHaveLength(2);
  });

  test("six functions on Node 22 arm64: two ingresses, the API, the work consumer, the intent runner and the sweep", () => {
    const t = template();
    const fns = Object.values(t.findResources("AWS::Lambda::Function")).map((r) => (r as { Properties: Record<string, unknown> }).Properties);
    const ours = fns.filter((f) => (f.Environment as { Variables?: Record<string, string> } | undefined)?.Variables?.ROVARA_ORCH_ROLE);
    expect(ours.map((f) => (f.Environment as { Variables: Record<string, string> }).Variables.ROVARA_ORCH_ROLE).sort()).toEqual(
      ["api", "github-ingress", "intent-runner", "rovara-ingress", "sweep", "work-consumer"].sort(),
    );
    for (const f of ours) {
      expect(f.Runtime).toBe("nodejs22.x");
      expect(f.Architectures).toEqual(["arm64"]);
    }
  });

  test("the intent runner reads the table stream; the consumer reads the queue; the sweep runs every minute", () => {
    const t = template();
    const mappings = Object.values(t.findResources("AWS::Lambda::EventSourceMapping")).map((r) => (r as { Properties: Record<string, unknown> }).Properties);
    expect(mappings).toHaveLength(2);
    expect(mappings.some((m) => (m.FunctionResponseTypes as string[] | undefined)?.includes("ReportBatchItemFailures"))).toBe(true);
    t.hasResourceProperties("AWS::Events::Rule", { ScheduleExpression: "rate(1 minute)" });
  });

  test("one role per function, and no wildcard actions in any policy", () => {
    const t = template();
    const fns = Object.values(t.findResources("AWS::Lambda::Function")).map((r) => JSON.stringify((r as { Properties: { Role: unknown } }).Properties.Role));
    expect(new Set(fns).size).toBe(fns.length);
    for (const p of Object.values(t.findResources("AWS::IAM::Policy"))) {
      for (const s of (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties.PolicyDocument.Statement) {
        for (const a of [s.Action].flat()) expect(a, `wildcard action ${a}`).not.toContain("*");
      }
    }
  });
});
