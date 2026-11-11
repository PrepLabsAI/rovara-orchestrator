import { afterEach, describe, expect, test } from "vitest";
import { signGithubBody } from "@rovara-orch/github";
import { handleGithubEvent, route } from "./ingress-github.js";
import { pullRequests } from "./github-events/pull-requests.js";
import { mainChecks } from "./github-events/main-checks.js";
import { checks } from "./github-events/checks.js";
import { testDeps } from "./testing/deps.js";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => cleanup?.());

const secret = "gh-secret";
const req = (event: string, delivery: string, payload: unknown, sig?: string) => {
  const body = JSON.stringify(payload);
  return { headers: { "X-GitHub-Event": event, "X-GitHub-Delivery": delivery, "X-Hub-Signature-256": sig ?? signGithubBody(secret, body) }, body };
};

describe("handleGithubEvent", () => {
  test("routes each event type, sending check events on main to the main-checks handler", () => {
    expect(route("pull_request", {})).toBe(pullRequests);
    expect(route("check_suite", { check_suite: { head_branch: "main" } })).toBe(mainChecks);
    expect(route("check_suite", { check_suite: { head_branch: "feature" } })).toBe(checks);
    expect(route("status", { branches: [{ name: "main" }] })).toBe(mainChecks);
    expect(route("issues", {})).toBeUndefined();
  });

  test("refuses a bad signature and ignores events nothing handles, once", async () => {
    const t = await testDeps("ingress-gh");
    cleanup = t.cleanup;
    expect((await handleGithubEvent(t.deps, secret, req("pull_request", "d1", {}, "sha256=00"))).status).toBe(401);
    expect(await handleGithubEvent(t.deps, secret, req("issues", "d2", {}))).toEqual({ status: 200, body: "ignored" });
    expect(await handleGithubEvent(t.deps, secret, req("issues", "d2", {}))).toEqual({ status: 200, body: "duplicate" });
  });

  test("writes one enqueue intent for the inputs, and a redelivery after a crash is processed once", async () => {
    const t = await testDeps("ingress-gh2");
    cleanup = t.cleanup;
    const handler = async () => [{ group: "att:att_1" as const, input: { kind: "start" as const } }];
    const r1 = await handleGithubEvent(t.deps, secret, req("pull_request", "d3", { action: "opened" }), () => handler);
    const r2 = await handleGithubEvent(t.deps, secret, req("pull_request", "d3", { action: "opened" }), () => handler);
    expect(r1).toEqual({ status: 200, body: "ok" });
    expect(r2).toEqual({ status: 200, body: "duplicate" });
    const pending = await t.deps.table.queryIndex<{ payload: { messages: Array<{ inputId: string }> } }>("PENDING_INTENT");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.payload.messages.map((m) => m.inputId)).toEqual(["gh:d3:0"]);
    expect(t.queued).toHaveLength(0);
  });
});
