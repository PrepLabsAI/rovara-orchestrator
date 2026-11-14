import { describe, expect, test } from "vitest";
import { ATTEMPT_PHASES, type Attempt, type NodeRunState } from "../../model.js";
import { anAttemptContext, aSettings } from "../../testing/fixtures.js";
import { attemptMachine } from "../attempt.js";
import type { AttemptContext, AttemptInput, AttemptTransition } from "../types.js";
import { happyPath } from "./happy-path.js";

const head = "h".repeat(40);
const rovara = (type: string, data: Record<string, unknown>, eventId = `evt_${type}0000000000000000`): AttemptInput => ({
  kind: "rovara",
  eventId,
  type: type as never,
  createdAt: "2026-11-11T01:00:00.000Z",
  data,
});
const approval = (actions = true) =>
  rovara("approval_request", {
    text: "plan",
    kind: "plan_approval",
    requestId: "8a6e0804-2bd0-4672-b79d-d97027f9071a",
    expectedRevision: 2,
    artifactDigest: "d".repeat(64),
    taskUrl: "https://rovara.test/tasks/t1",
    ...(actions ? { actions: [{ decision: "APPROVE", label: "Approve" }] } : {}),
  });

/** Apply a transition to the context, like the consumer does. */
function apply(ctx: AttemptContext, t: AttemptTransition | undefined): AttemptContext {
  if (!t) return ctx;
  return { ...ctx, attempt: { ...(t.attempt ?? ctx.attempt), version: ctx.attempt.version + 1 }, node: { ...(t.node ?? ctx.node), version: ctx.node.version + 1 } as NodeRunState };
}

describe("happy path", () => {
  test("walks the attempt phases in order, from start to merged", () => {
    let ctx = anAttemptContext();
    const seen: Attempt["phase"][] = [ctx.attempt.phase];
    const steps: AttemptInput[] = [
      { kind: "start" },
      rovara("ack", { inReplyTo: "brief" }),
      approval(),
      rovara("check_report", { status: "passed", text: "ok" }),
      rovara("pr", { url: "https://github.com/acme/mono/pull/7", title: "US1" }),
      { kind: "github", deliveryId: "d1", event: { type: "pr_opened", number: 7, headSha: head, baseRef: "main", repo: "acme/mono", changedFiles: 2 } },
      { kind: "github", deliveryId: "d2", event: { type: "checks", number: 7, headSha: head, scope: "pr", status: "passed", failing: [] } },
      { kind: "github", deliveryId: "d3", event: { type: "review_state", number: 7, headSha: head, reviewed: true, threads: [] } },
      { kind: "github", deliveryId: "d4", event: { type: "merged_on_main", number: 7, mergeCommit: "m".repeat(40) } },
    ];
    for (const input of steps) {
      ctx = apply(ctx, attemptMachine(ctx, input));
      seen.push(ctx.attempt.phase);
    }
    const order = seen.map((p) => ATTEMPT_PHASES.indexOf(p));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(seen)).toEqual(new Set(["starting", "planning", "coding", "pr_requested", "pr_open", "queued", "merged"]));
    expect(ctx.node.state).toBe("merged");
    expect(ctx.node.mergeCommit).toBe("m".repeat(40));
  });

  test("start sends the node brief", () => {
    const t = happyPath(anAttemptContext(), { kind: "start" })!;
    expect(t.intents).toHaveLength(1);
    expect(t.intents[0]).toMatchObject({ effect: "rovara.message" });
    expect(String(t.intents[0]!.payload.text)).toMatch(/implement the tasks in order/i);
  });

  test("a plan approval records the Rovara task link and approves, echoing the request", () => {
    const ctx = anAttemptContext({ attempt: { ...anAttemptContext().attempt, phase: "planning" } });
    const t = happyPath(ctx, approval())!;
    expect(t.attempt?.rovaraTaskUrl).toBe("https://rovara.test/tasks/t1");
    expect(t.intents).toEqual([
      expect.objectContaining({
        effect: "rovara.decision",
        payload: expect.objectContaining({ requestId: "8a6e0804-2bd0-4672-b79d-d97027f9071a", expectedRevision: 2, artifactDigest: "d".repeat(64), decision: "APPROVE" }),
      }),
    ]);
    expect(t.decisions.map((d) => d.action)).toEqual(["approve"]);
  });

  test("while the stop switch is on, the approval is held, and it is sent once when released", () => {
    const stopped = anAttemptContext({ settings: aSettings({ stopSwitch: { on: true, by: "op", at: "t", reason: "x" } }) });
    const t = happyPath({ ...stopped, attempt: { ...stopped.attempt, phase: "planning" } }, approval())!;
    expect(t.intents).toHaveLength(0);
    expect(t.attempt?.plan?.held).toBe(true);
    const held = { ...stopped, attempt: t.attempt!, settings: aSettings() };
    const r = attemptMachine(held, { kind: "control", action: "release", by: "op", reason: "stop switch off" })!;
    expect(r.intents.filter((i) => i.effect === "rovara.decision")).toHaveLength(1);
    expect(r.attempt?.plan?.held).toBe(false);
    const again = attemptMachine({ ...held, attempt: r.attempt! }, { kind: "control", action: "release", by: "op", reason: "again" });
    expect(again?.intents.filter((i) => i.effect === "rovara.decision") ?? []).toHaveLength(0);
  });

  test("a PR that became ready while the stop switch was on is queued once when released", () => {
    const base = anAttemptContext();
    const ready = {
      ...base,
      attempt: {
        ...base.attempt,
        phase: "pr_open" as const,
        checkReports: [{ status: "passed" as const, at: "t", text: "ok" }],
        pullRequests: [{ number: 7, url: "u", headSha: head, state: "open" as const, openedAt: "t", changedFiles: 1, baseRef: "main", repo: "acme/mono", mergeCommit: null }],
        review: { headSha: head, reviewedAt: "t", rerequestedAt: null, unresolved: 0, sent: [] },
        ci: { headSha: head, pr: "passed" as const, queue: "none" as const, failing: [] },
      },
      node: { ...base.node, state: "pr_open" as const },
    };
    const release = { kind: "control", action: "release", by: "op", reason: "stop switch off" } as const;
    const stopped = { ...ready, settings: aSettings({ stopSwitch: { on: true, by: "op", at: "t", reason: "x" } }) };
    expect(attemptMachine(stopped, release)?.intents ?? []).toHaveLength(0);
    const r = attemptMachine(ready, release)!;
    expect(r.intents.map((i) => i.effect)).toEqual(["github.enqueue"]);
    expect(r.decisions.map((d) => d.action)).toEqual(["merge"]);
    expect(attemptMachine(apply(ready, r), release)?.intents ?? []).toHaveLength(0);
  });

  test("a passed check report with no PR asks for the pull request", () => {
    const ctx = anAttemptContext({ attempt: { ...anAttemptContext().attempt, phase: "coding" } });
    const t = happyPath(ctx, rovara("check_report", { status: "passed", text: "ok" }))!;
    expect(t.intents).toEqual([expect.objectContaining({ effect: "rovara.message", payload: expect.objectContaining({ text: "Checks passed. Create the pull request." }) })]);
    expect(t.attempt?.phase).toBe("pr_requested");
  });

  test("a question goes to the answering model", () => {
    const ctx = anAttemptContext({ attempt: { ...anAttemptContext().attempt, phase: "coding" } });
    const t = happyPath(ctx, rovara("question", { text: "24h or 7d?", choices: ["24h", "7d"] }, "evt_q00000000000000001"))!;
    expect(t.intents).toEqual([expect.objectContaining({ effect: "model.answer", payload: expect.objectContaining({ question: "24h or 7d?", choices: ["24h", "7d"], eventId: "evt_q00000000000000001" }) })]);
    expect(t.decisions.map((d) => d.action)).toEqual(["answer"]);
  });

  test("a node counts as merged only once its merge commit is on main", () => {
    const base = anAttemptContext();
    const ctx = { ...base, attempt: { ...base.attempt, phase: "queued" as const, pullRequests: [{ number: 7, url: "u", headSha: head, state: "open" as const, openedAt: "t", changedFiles: 1, baseRef: "main", repo: "acme/mono", mergeCommit: null }] }, node: { ...base.node, state: "in_merge_queue" as const } };
    const closed = happyPath(ctx, { kind: "github", deliveryId: "d", event: { type: "pr_closed", number: 7, merged: true, mergeCommit: "m".repeat(40) } })!;
    expect(closed.node?.state ?? ctx.node.state).toBe("in_merge_queue");
    const merged = happyPath(ctx, { kind: "github", deliveryId: "d2", event: { type: "merged_on_main", number: 7, mergeCommit: "m".repeat(40) } })!;
    expect(merged.node?.state).toBe("merged");
    expect(merged.intents.map((i) => i.effect)).toContain("rovara.close");
  });

  test("an event for an attempt that is not current changes nothing", () => {
    const base = anAttemptContext();
    const ctx = { ...base, node: { ...base.node, currentAttempt: "att_other" } };
    expect(attemptMachine(ctx, rovara("check_report", { status: "passed", text: "ok" }))).toBeUndefined();
  });

  test("every automatic approve, answer and merge writes a decision record", () => {
    const base = anAttemptContext();
    const approve = happyPath({ ...base, attempt: { ...base.attempt, phase: "planning" } }, approval())!;
    const answer = happyPath({ ...base, attempt: { ...base.attempt, phase: "coding" } }, rovara("question", { text: "?" }))!;
    expect(approve.decisions[0]).toMatchObject({ actor: "orchestrator", action: "approve" });
    expect(answer.decisions[0]).toMatchObject({ actor: "orchestrator", action: "answer" });
    const ready = {
      ...base,
      attempt: {
        ...base.attempt,
        phase: "pr_open" as const,
        checkReports: [{ status: "passed" as const, at: "t", text: "ok" }],
        pullRequests: [{ number: 7, url: "u", headSha: head, state: "open" as const, openedAt: "t", changedFiles: 1, baseRef: "main", repo: "acme/mono", mergeCommit: null }],
        review: { headSha: head, reviewedAt: "t", rerequestedAt: null, unresolved: 0, sent: [] },
      },
      node: { ...base.node, state: "pr_open" as const },
    };
    const merge = happyPath(ready, { kind: "github", deliveryId: "d", event: { type: "checks", number: 7, headSha: head, scope: "pr", status: "passed", failing: [] } })!;
    expect(merge.intents.map((i) => i.effect)).toContain("github.enqueue");
    expect(merge.decisions[0]).toMatchObject({ actor: "orchestrator", action: "merge" });
  });
});
