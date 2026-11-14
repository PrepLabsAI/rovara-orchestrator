import { describe, expect, test } from "vitest";
import { cliHarness } from "./testing.js";

const node = {
  pageUrl: "https://status.test/#/runs/run_1/nodes/US1",
  nodeId: "US1",
  title: "Sign up",
  state: "pr_open",
  waitingFor: null,
  attempts: [
    {
      n: 1,
      phase: "pr_open",
      rovaraTaskUrl: "https://rovara.test/tasks/t1",
      pullRequests: [{ number: 7, url: "https://github.com/acme/mono/pull/7", state: "open" }],
      questions: [{ question: "24h or 7d?", answer: "Use 24h.", answeredBy: "anthropic.claude-opus-5-5" }],
      reviewComments: [{ path: "src/a.ts", line: 12, body: "Handle null.", resolution: "fixed" }],
      checkReports: [{ status: "passed" }],
    },
  ],
  decisions: [{ at: "2026-11-11T00:01:00.000Z", actor: "orchestrator", action: "approve", reason: "plan approved" }],
};

describe("rovara-orch node show", () => {
  test("prints the attempts, PRs, questions, review comments and decisions, and links the node page", async () => {
    const t = cliHarness(() => ({ status: 200, body: node }));
    expect(await t.run("node", "show", "run_1", "US1")).toBe(0);
    expect(t.calls[0]).toMatchObject({ method: "GET", path: "/v1/runs/run_1/nodes/US1" });
    const out = t.lines.join("\n");
    for (const s of ["US1", "Sign up", "pr_open", "https://github.com/acme/mono/pull/7", "24h or 7d?", "Use 24h.", "src/a.ts:12", "Handle null.", "approve", "https://rovara.test/tasks/t1", "https://status.test/#/runs/run_1/nodes/US1"]) {
      expect(out).toContain(s);
    }
  });

  test("never prints the trace: it points to the node page for that", async () => {
    const t = cliHarness(() => ({ status: 200, body: node }));
    await t.run("node", "show", "run_1", "US1");
    expect(t.calls.some((c) => c.path.includes("/trace"))).toBe(false);
    expect(t.lines.join("\n")).toMatch(/trace.*node page/i);
  });
});
