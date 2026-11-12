import { describe, expect, test } from "vitest";
import type { Attempt, NodeRunState, PullRequestRef } from "../../model.js";
import { anAttemptContext, aRun } from "../../testing/fixtures.js";
import { attemptMachine } from "../attempt.js";
import type { AttemptContext, AttemptInput } from "../types.js";

const rovara = (type: string, data: Record<string, unknown>, eventId = `evt_${type}000000000000000000`): AttemptInput =>
  ({ kind: "rovara", type, eventId, createdAt: "t", data }) as AttemptInput;
const report = (status: "failed" | "unknown") => rovara("check_report", { status, text: `Checks ${status}: lint.` });
const pr: PullRequestRef = { number: 7, url: "https://github.com/acme/mono/pull/7", headSha: "h".repeat(40), state: "open", openedAt: "t", changedFiles: 1, baseRef: "main", repo: "acme/mono", mergeCommit: null };

function ctxWith(attempt: Partial<Attempt> = {}, node: Partial<NodeRunState> = {}): AttemptContext {
  const base = anAttemptContext({ run: aRun({ retry: { fixRequests: 2, attempts: 3, prUpdates: 3, reviewRounds: 3, quietMinutes: 30 } }) });
  return { ...base, attempt: { ...base.attempt, phase: "coding", ...attempt }, node: { ...base.node, state: "running", attempts: 1, ...node } };
}
const effects = (t: ReturnType<typeof attemptMachine>) => t?.intents.map((i) => i.effect) ?? [];

describe("failed checks", () => {
  test.each(["failed", "unknown"] as const)("a %s check report sends a fix request in the same conversation while fix requests remain", (status) => {
    const t = attemptMachine(ctxWith({ fixRequests: 1 }), report(status))!;
    expect(effects(t)).toEqual(["rovara.message"]);
    expect(String(t.intents[0]!.payload.text)).toContain(`Checks ${status}: lint.`);
    expect(t.attempt).toMatchObject({ fixRequests: 2, phase: "coding" });
    expect(t.node?.state).toBe("checks_failed");
    expect(t.attempt?.checkReports.at(-1)).toMatchObject({ status });
  });

  test("a passed report after a fix moves the node back to running", () => {
    const t = attemptMachine(ctxWith({ fixRequests: 1 }, { state: "checks_failed" }), rovara("check_report", { status: "passed", text: "ok" }))!;
    expect(t.node?.state).toBe("running");
  });

  test("out of fix requests: a new attempt, closing this one's workspace and its open PR", () => {
    const ctx = ctxWith({ fixRequests: 2, pullRequests: [pr] }, { attempts: 1 });
    const t = attemptMachine(ctx, report("failed"))!;
    expect(effects(t).sort()).toEqual(["github.close_pr", "rovara.close"]);
    expect(t.attempt).toMatchObject({ phase: "abandoned", outcome: "abandoned" });
    expect(t.attempt?.outcomeReason).toMatch(/fix requests/);
    expect(t.node).toMatchObject({ state: "eligible", waitingFor: null });
    expect(t.decisions.map((d) => d.action)).toEqual(["retry"]);
  });

  test("out of fix requests and attempts: escalated with one Slack message; the workspace stays for a person to look at", () => {
    const t = attemptMachine(ctxWith({ fixRequests: 2 }, { attempts: 3 }), report("failed"))!;
    expect(effects(t)).toEqual(["slack.post"]);
    expect(t.intents[0]!.payload).toMatchObject({ template: "nodeEscalated" });
    expect(t.node?.state).toBe("escalated");
    expect(t.attempt).toMatchObject({ phase: "failed", outcome: "failed" });
    expect(t.decisions.map((d) => d.action)).toEqual(["escalate"]);
  });

  test("after an operator retry the node has a fresh set of attempts", () => {
    const t = attemptMachine(ctxWith({ fixRequests: 2 }, { attempts: 4, attemptsBeforeRetry: 3 }), report("failed"))!;
    expect(t.node?.state).toBe("eligible");
  });
});

describe("workspace and conversation failures", () => {
  test.each([
    ["a workspace that fails to start", rovara("error", { code: "workspace_failed", text: "The workspace could not start." })],
    ["a conversation error", rovara("error", { code: "internal", text: "Something broke." })],
  ])("%s starts a new attempt while attempts remain", (_name, input) => {
    const t = attemptMachine(ctxWith({ phase: "starting" }), input)!;
    expect(t.node?.state).toBe("eligible");
    expect(t.attempt?.phase).toBe("abandoned");
    expect(effects(t)).toEqual(["rovara.close"]);
  });

  test("an error with no attempts left escalates", () => {
    const t = attemptMachine(ctxWith({}, { attempts: 3 }), rovara("error", { code: "internal", text: "x" }))!;
    expect(t.node?.state).toBe("escalated");
  });

  test("a workspace-limit refusal is not a failure: no retry, no escalation (capacity handles it)", () => {
    const t = attemptMachine(ctxWith({ phase: "starting" }, { attempts: 3 }), rovara("error", { code: "workspace_limit", text: "full" }))!;
    expect(t.node?.state).toBe("waiting");
    expect(t.decisions).toHaveLength(0);
  });

  test("a repeated failure event changes nothing", () => {
    const ctx = ctxWith({ phase: "starting" });
    const input = rovara("error", { code: "internal", text: "x" });
    const t = attemptMachine(ctx, input)!;
    expect(attemptMachine({ ...ctx, attempt: t.attempt!, node: t.node! }, input)).toBeUndefined();
  });
});

describe("approval requests the orchestrator does not answer", () => {
  const request = (kind: string, actions = true) =>
    rovara("approval_request", {
      text: "?",
      kind,
      requestId: "b0a55628-02db-4555-9e92-5b9c52d1ba1d",
      expectedRevision: 1,
      artifactDigest: "a".repeat(64),
      ...(actions ? { actions: [{ decision: "APPROVE", label: "Approve" }] } : {}),
    });

  test("an admin request escalates with the administrator notification", () => {
    const t = attemptMachine(ctxWith({ phase: "planning" }), request("admin"))!;
    expect(t.node?.state).toBe("escalated");
    expect(t.intents[0]!.payload).toMatchObject({ template: "adminRequest" });
    expect(effects(t)).not.toContain("rovara.decision");
  });

  test("an unknown kind of confirmation escalates", () => {
    const t = attemptMachine(ctxWith({ phase: "planning" }), request("other"))!;
    expect(t.node?.state).toBe("escalated");
    expect(effects(t)).not.toContain("rovara.decision");
  });

  test("a plan approval with no approve actions escalates: the adapter is registered with step-up", () => {
    const t = attemptMachine(ctxWith({ phase: "planning" }), request("plan_approval", false))!;
    expect(t.node?.state).toBe("escalated");
    expect(t.node?.escalation?.reason).toBe("adapter registered with step-up");
  });
});

describe("a quiet attempt (until Rovara#437)", () => {
  test("escalates, never retries, so no second workspace starts for work that may still run", () => {
    const at = "2026-11-11T00:30:00.000Z";
    const t = attemptMachine(ctxWith({ due: { quietAt: at, reviewAt: null, retryAt: null } }), { kind: "timer", timer: "quiet", at })!;
    expect(t.node?.state).toBe("escalated");
    expect(t.node?.escalation?.reason).toMatch(/no news from Rovara for 30 minutes/);
  });

  test("a timer for an older due time changes nothing", () => {
    const ctx = ctxWith({ due: { quietAt: "2026-11-11T00:45:00.000Z", reviewAt: null, retryAt: null } });
    expect(attemptMachine(ctx, { kind: "timer", timer: "quiet", at: "2026-11-11T00:30:00.000Z" })).toBeUndefined();
  });
});

describe("the PR, by hand or empty", () => {
  const github = (event: Extract<AttemptInput, { kind: "github" }>["event"]): AttemptInput => ({ kind: "github", deliveryId: "d1", event });
  const withPr = () => ctxWith({ phase: "pr_open", pullRequests: [pr] }, { state: "pr_open" });

  test("a PR closed without merge by a person fails the attempt", () => {
    const t = attemptMachine(withPr(), github({ type: "pr_closed", number: 7, merged: false, mergeCommit: null }))!;
    expect(t.attempt?.phase).toBe("abandoned");
    expect(t.attempt?.outcomeReason).toMatch(/closed without merging/);
    expect(t.node?.state).toBe("eligible");
    expect(effects(t)).toEqual(["rovara.close"]); // the PR is already closed
  });

  test("a PR merged by a person counts as merged", () => {
    const t = attemptMachine(withPr(), github({ type: "merged_on_main", number: 7, mergeCommit: "m".repeat(40) }))!;
    expect(t.node).toMatchObject({ state: "merged", mergeCommit: "m".repeat(40) });
  });

  test("a PR with no changes fails the attempt with reason no_changes", () => {
    const t = attemptMachine(withPr(), github({ type: "pr_opened", number: 7, headSha: pr.headSha!, baseRef: "main", repo: "acme/mono", changedFiles: 0 }))!;
    expect(t.attempt).toMatchObject({ phase: "abandoned", outcomeReason: "no_changes" });
    expect(effects(t).sort()).toEqual(["github.close_pr", "rovara.close"]);
  });
});
