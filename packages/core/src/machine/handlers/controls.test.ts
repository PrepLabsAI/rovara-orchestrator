import { describe, expect, test } from "vitest";
import type { QueueMessage } from "../helpers.js";
import { aNode, anAttemptContext, aRun, aRunContext } from "../../testing/fixtures.js";
import { attemptMachine } from "../attempt.js";
import type { AttemptContext, AttemptTransition } from "../types.js";
import { controls, runControls } from "./controls.js";

const runId = "run_01TEST000000000000000000000";
const op = { by: "dev_alice", reason: "testing", decisionId: "dec_1" };

describe("run controls", () => {
  test("pause stops new starts (run paused) and records the decision; resume runs again", () => {
    const ctx = aRunContext({ run: aRun({ runId }) });
    const paused = runControls(ctx, { kind: "pause", ...op })!;
    expect(paused.run).toMatchObject({ state: "paused", pausedFor: "operator" });
    expect(paused.decisions).toEqual([expect.objectContaining({ actor: "dev_alice", action: "pause", reason: "testing" })]);
    const resumed = runControls({ ...ctx, run: paused.run! }, { kind: "resume", ...op })!;
    expect(resumed.run).toMatchObject({ state: "running", pausedFor: null });
  });

  test("cancel ends the run, cancels nodes without attempts, and sends one cancel input per active attempt", () => {
    const nodes = [
      aNode({ runId, nodeId: "A", state: "running", currentAttempt: "att_A" }),
      aNode({ runId, nodeId: "B", state: "pr_open", currentAttempt: "att_B" }),
      aNode({ runId, nodeId: "C", state: "waiting" }),
      aNode({ runId, nodeId: "D", state: "merged", currentAttempt: "att_D" }),
    ];
    const t = runControls(aRunContext({ run: aRun({ runId, counts: { running: 1, pr_open: 1, waiting: 1, merged: 1 } }), nodes }), { kind: "cancel", ...op })!;
    expect(t.run).toMatchObject({ state: "cancelled" });
    expect(t.run?.endedAt).toBeTruthy();
    expect(t.nodes?.map((n) => [n.nodeId, n.state])).toEqual([["C", "cancelled"]]);
    const fanout = t.intents.filter((i) => i.effect === "queue.enqueue");
    expect(fanout).toHaveLength(1);
    const messages = (fanout[0]!.payload.messages as QueueMessage[]).map((m) => m.group);
    expect(messages.sort()).toEqual(["att:att_A", "att:att_B"]);
    expect(t.records).toEqual(expect.arrayContaining([{ kind: "delete", key: { pk: `DAGRUN#${aRun().dagId}`, sk: "ACTIVE" } }]));
  });

  test("cancelling a cancelled run does nothing", () => {
    expect(runControls(aRunContext({ run: aRun({ runId, state: "cancelled" }) }), { kind: "cancel", ...op })).toBeUndefined();
  });
});

describe("attempt controls", () => {
  const pr = { number: 7, url: "u", headSha: "h", state: "open" as const, openedAt: "t", changedFiles: 1, baseRef: "main", repo: "acme/mono", mergeCommit: null };

  test("a cancel stops the task, closes the workspace and closes the unmerged PR, each once", () => {
    const base = anAttemptContext();
    const ctx = { ...base, attempt: { ...base.attempt, phase: "pr_open" as const, pullRequests: [pr] }, node: { ...base.node, state: "pr_open" as const } };
    const t = controls(ctx, { kind: "control", action: "cancel", by: "dev_alice", reason: "run cancelled" })!;
    expect(t.intents.map((i) => i.effect).sort()).toEqual(["github.close_pr", "rovara.cancel", "rovara.close"]);
    expect(t.attempt).toMatchObject({ phase: "cancelled", outcome: "cancelled" });
    expect(t.node?.state).toBe("cancelled");
    const again = controls({ ...ctx, attempt: t.attempt!, node: t.node! }, { kind: "control", action: "cancel", by: "dev_alice", reason: "again" });
    expect(again).toBeUndefined();
  });

  test("a cancel after the merge completed changes nothing: the node stays merged", () => {
    const base = anAttemptContext();
    const ctx = { ...base, attempt: { ...base.attempt, phase: "merged" as const, outcome: "merged" as const, pullRequests: [{ ...pr, state: "merged" as const }] }, node: { ...base.node, state: "merged" as const } };
    expect(controls(ctx, { kind: "control", action: "cancel", by: "dev_alice", reason: "late" })).toBeUndefined();
  });

  /** An attempt cancelled while its PR was open (the node is cancelled). */
  function cancelledWithPr(): AttemptContext {
    const base = anAttemptContext();
    const ctx = { ...base, attempt: { ...base.attempt, phase: "queued" as const, pullRequests: [pr] }, node: { ...base.node, state: "in_merge_queue" as const } };
    const t = controls(ctx, { kind: "control", action: "cancel", by: "dev_alice", reason: "run cancelled" })!;
    return { ...ctx, attempt: t.attempt!, node: t.node! };
  }
  const apply = (ctx: AttemptContext, t: AttemptTransition) => ({ ...ctx, attempt: t.attempt ?? ctx.attempt, node: t.node ?? ctx.node });

  test("a merge that reaches main after the cancel wins: the node is merged, once (never both)", () => {
    const ctx = cancelledWithPr();
    const merged = { kind: "github", deliveryId: "d", event: { type: "merged_on_main", number: 7, mergeCommit: "m".repeat(40) } } as const;
    const t = attemptMachine(ctx, merged)!;
    expect(t.node).toMatchObject({ state: "merged", mergeCommit: "m".repeat(40) });
    expect(t.counters?.counts).toEqual({ cancelled: -1, merged: 1 });
    expect(t.intents.map((i) => i.key)).toEqual([`${ctx.attempt.attemptId}.close`]); // the same key as the cancel's close
    expect(attemptMachine(apply(ctx, t), { ...merged, deliveryId: "d2" })).toBeUndefined();
  });

  test("a PR Rovara reports after the cancel is closed, and the node stays cancelled", () => {
    const ctx = cancelledWithPr();
    const late = { kind: "rovara", type: "pr", eventId: "evt_pr00000000000000000009", createdAt: "t", data: { url: "https://github.com/acme/mono/pull/9" } } as const;
    const t = attemptMachine(ctx, late)!;
    expect(t.intents.map((i) => [i.effect, i.payload.number])).toEqual([["github.close_pr", 9]]);
    expect(t.node?.state ?? ctx.node.state).toBe("cancelled");
    expect(attemptMachine(apply(ctx, t), late)).toBeUndefined();
  });

  test("any other input after the cancel changes nothing", () => {
    const ctx = cancelledWithPr();
    expect(attemptMachine(ctx, { kind: "rovara", type: "check_report", eventId: "evt_c", createdAt: "t", data: { status: "passed" } })).toBeUndefined();
    expect(attemptMachine(ctx, { kind: "github", deliveryId: "d", event: { type: "checks", number: 7, headSha: "h", scope: "pr", status: "passed", failing: [] } })).toBeUndefined();
  });
});
