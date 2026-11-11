import { describe, expect, test } from "vitest";
import type { Run } from "../../model.js";
import { anAttemptContext, aRun, aRunContext } from "../../testing/fixtures.js";
import { attemptMachine } from "../attempt.js";
import { runMachine } from "../run.js";
import type { RunContext, RunTransition } from "../types.js";

const runId = "run_01TEST000000000000000000000";
const ctxWith = (run: Partial<Run> = {}): RunContext => aRunContext({ run: aRun({ runId, actingFor: "dev_alice", costLimitUsd: 50, ...run }) });
const apply = (c: RunContext, t: RunTransition): RunContext => ({ ...c, run: t.run ?? c.run });
const op = (kind: "take_over" | "resume" | "cancel", by = "dev_bob") => ({ kind, by, reason: "covering for Alice", decisionId: "dec_7" }) as const;

describe("take-over (FR-057)", () => {
  test("sets actingFor to the operator and records who took over", () => {
    const t = runMachine(ctxWith(), op("take_over"))!;
    expect(t.run?.actingFor).toBe("dev_bob");
    expect(t.decisions).toEqual([expect.objectContaining({ actor: "dev_bob", action: "take_over", reason: "covering for Alice" })]);
  });
});

describe("the run pauses when its operator loses Rovara access", () => {
  test("lost access for the acting-for operator pauses the run with one Slack message, and starts a new access generation", () => {
    const t = runMachine(ctxWith(), { kind: "lost_access", operator: "dev_alice" })!;
    expect(t.run).toMatchObject({ state: "paused", pausedFor: "lost_access", accessGeneration: 1 });
    expect(t.intents.map((i) => i.effect)).toEqual(["slack.post"]);
    expect(t.intents[0]!.payload).toMatchObject({ template: "lostAccess", params: { runId, operator: "dev_alice" } });
    expect(t.run?.pauseNotice?.slackKey).toBe(t.intents[0]!.key);
  });

  test("a repeat, or lost access for someone the run no longer acts for, changes nothing", () => {
    const paused = apply(ctxWith(), runMachine(ctxWith(), { kind: "lost_access", operator: "dev_alice" })!);
    expect(runMachine(paused, { kind: "lost_access", operator: "dev_alice" })).toBeUndefined();
    expect(runMachine(ctxWith(), { kind: "lost_access", operator: "dev_carol" })).toBeUndefined();
  });

  test("a take-over resumes it, with a thread reply naming who took over", () => {
    const paused = apply(ctxWith(), runMachine(ctxWith(), { kind: "lost_access", operator: "dev_alice" })!);
    const t = runMachine(paused, op("take_over"))!;
    expect(t.run).toMatchObject({ state: "running", pausedFor: null, actingFor: "dev_bob", pauseNotice: null });
    const reply = t.intents.find((i) => i.effect === "slack.reply")!;
    expect(reply.payload).toMatchObject({ replyTo: paused.run.pauseNotice!.slackKey, template: "runResolved", params: { how: "taken over", operator: "dev_bob" } });
  });

  test("a link_required event in a conversation tells the run", () => {
    const ctx = anAttemptContext({ run: aRun({ runId, actingFor: "dev_alice" }) });
    const t = attemptMachine(ctx, {
      kind: "rovara",
      type: "link_required",
      eventId: "evt_link000000000000000001",
      createdAt: "t",
      data: { linkUrl: "https://rovara.test/link/x", expiresAt: "2026-11-11T02:00:00.000Z", actor: { channel: "orchestrator", tenant: "t", userId: "dev_alice" } },
    })!;
    const sent = t.intents.find((i) => i.effect === "queue.enqueue")!;
    expect(sent.payload.messages).toEqual([expect.objectContaining({ group: `run:${runId}`, input: { kind: "lost_access", operator: "dev_alice" } })]);
  });
});

describe("the run pauses at its cost limit (FR-052)", () => {
  test("an answer that takes the run to its limit tells the run", () => {
    const ctx = anAttemptContext({ run: aRun({ runId, costUsd: 49.5, costLimitUsd: 50 }) });
    const t = attemptMachine(ctx, { kind: "answered", eventId: "evt_q1", costUsd: 0.75 })!;
    expect(t.intents.find((i) => i.effect === "queue.enqueue")?.payload.messages).toEqual([expect.objectContaining({ group: `run:${runId}`, input: { kind: "cost_limit" } })]);
    const under = attemptMachine(anAttemptContext({ run: aRun({ runId, costUsd: 10, costLimitUsd: 50 }) }), { kind: "answered", eventId: "evt_q2", costUsd: 0.75 })!;
    expect(under.intents).toHaveLength(0);
  });

  test("at or over the limit the run pauses with one Slack message; under it nothing happens", () => {
    const t = runMachine(ctxWith({ costUsd: 50.25 }), { kind: "cost_limit" })!;
    expect(t.run).toMatchObject({ state: "paused", pausedFor: "cost" });
    expect(t.intents[0]!.payload).toMatchObject({ template: "costLimit", params: { runId, limitUsd: 50 } });
    expect(runMachine(ctxWith({ costUsd: 20 }), { kind: "cost_limit" })).toBeUndefined();
  });

  test.each([
    ["resume", "resumed"],
    ["cancel", "cancelled"],
  ] as const)("%s replies in the thread", (kind, how) => {
    const paused = apply(ctxWith({ costUsd: 51 }), runMachine(ctxWith({ costUsd: 51 }), { kind: "cost_limit" })!);
    const t = runMachine(paused, op(kind))!;
    expect(t.intents.find((i) => i.effect === "slack.reply")?.payload).toMatchObject({ template: "runResolved", params: { how, operator: "dev_bob" } });
  });
});
