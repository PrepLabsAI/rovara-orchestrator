import { describe, expect, test } from "vitest";
import { cliHarness } from "./testing.js";

const run = {
  runId: "run_1",
  dagId: "dag_1",
  state: "running",
  concurrencyLimit: 3,
  costLimitUsd: 50,
  costUsd: 1.25,
  counts: { running: 2, merged: 1, waiting: 0 },
  actingFor: "dev_alice",
  startedAt: "2026-11-11T00:00:00.000Z",
  nodes: [
    { nodeId: "setup", title: "Setup", state: "merged", waitingFor: null, attempt: 1, rovaraTaskUrl: null, pullRequests: [{ number: 1, url: "https://github.com/acme/mono/pull/1", state: "merged" }] },
    { nodeId: "US1", title: "Sign up", state: "eligible", waitingFor: { reason: "capacity" }, attempt: null, rovaraTaskUrl: null, pullRequests: [] },
  ],
};

describe("rovara-orch run", () => {
  test("start posts the DAG, limits and every retry option, and prints the run id and page link", async () => {
    const t = cliHarness(() => ({ status: 201, body: { runId: "run_1", pageUrl: "https://status.test/#/runs/run_1" } }));
    const code = await t.run("run", "start", "dag_1", "--concurrency", "3", "--cost-limit", "50", "--attempts", "4", "--fix-requests", "1", "--pr-updates", "2", "--review-rounds", "5", "--quiet-minutes", "45");
    expect(code).toBe(0);
    expect(t.calls[0]).toMatchObject({
      method: "POST",
      path: "/v1/runs",
      body: { dagId: "dag_1", concurrencyLimit: 3, costLimitUsd: 50, retry: { attempts: 4, fixRequests: 1, prUpdates: 2, reviewRounds: 5, quietMinutes: 45 } },
    });
    expect(t.lines.join("\n")).toContain("run_1");
    expect(t.lines.join("\n")).toContain("Status page: https://status.test/#/runs/run_1");
  });

  test("start without the retry options sends none", async () => {
    const t = cliHarness(() => ({ status: 201, body: { runId: "run_1" } }));
    await t.run("run", "start", "dag_1", "--concurrency", "2", "--cost-limit", "10");
    expect(t.calls[0]!.body).toEqual({ dagId: "dag_1", concurrencyLimit: 2, costLimitUsd: 10 });
  });

  test("an operator who has not linked Rovara is shown the link and exits 1", async () => {
    const t = cliHarness(() => ({ status: 422, body: { error: { code: "INVALID", message: "link your Rovara sign-in first", problem: "not_linked", linkUrl: "https://rovara.test/link/abc" } } }));
    expect(await t.run("run", "start", "dag_1", "--concurrency", "2", "--cost-limit", "10")).toBe(1);
    expect(t.errors.join("\n")).toContain("https://rovara.test/link/abc");
  });

  test("start needs its options", async () => {
    const t = cliHarness(() => ({ status: 201, body: {} }));
    expect(await t.run("run", "start", "dag_1")).toBe(2);
  });

  test("list and status print the runs and the nodes with what they wait for", async () => {
    const t = cliHarness((_m, path) => (path === "/v1/runs" ? { status: 200, body: { items: [run] } } : { status: 200, body: run }));
    expect(await t.run("run", "list")).toBe(0);
    expect(t.lines[0]).toContain("run_1");
    expect(await t.run("run", "status", "run_1")).toBe(0);
    const out = t.lines.join("\n");
    expect(out).toContain("running 2");
    expect(out).toContain("$1.25");
    expect(out).toMatch(/US1.*eligible.*capacity/);
    expect(out).toContain("https://github.com/acme/mono/pull/1");
  });
});
