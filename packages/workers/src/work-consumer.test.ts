import { afterEach, describe, expect, test } from "vitest";
import { moveNode, type AttemptTransition, type QueueMessage } from "@rovara-orch/core";
import { encodeAttempt, encodeDag, encodeDagNode, encodeNode, encodeRun, keys } from "@rovara-orch/store";
import { aDag, aDagNode, aNode, anAttempt, aRun } from "@rovara-orch/store/testing";
import { consume, DEFAULT_MACHINES, type Machines } from "./work-consumer.js";
import { testDeps } from "./testing/deps.js";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => cleanup?.());

async function seeded() {
  const t = await testDeps("consumer");
  cleanup = t.cleanup;
  const run = aRun({ counts: { running: 1 } });
  const node = aNode({ state: "running", currentAttempt: "x" });
  const attempt = anAttempt({ phase: "queued" });
  await t.deps.table.transact([
    { kind: "put", item: encodeDag(aDag()) },
    { kind: "put", item: encodeDagNode(aDagNode()) },
    { kind: "put", item: encodeRun(run) },
    { kind: "put", item: encodeNode({ ...node, currentAttempt: attempt.attemptId }) },
    { kind: "put", item: encodeAttempt(attempt) },
  ]);
  return { ...t, run, node: { ...node, currentAttempt: attempt.attemptId }, attempt };
}

const mergeMachine: Machines = {
  ...DEFAULT_MACHINES,
  attempt: (ctx) => {
    const { node, counters } = moveNode(ctx.node, "merged", { mergeCommit: "m".repeat(40) });
    return {
      attempt: { ...ctx.attempt, phase: "merged", outcome: "merged" },
      node,
      counters,
      intents: [{ effect: "rovara.close", key: `${ctx.attempt.attemptId}.close`, payload: {} }],
      decisions: [{ actor: "orchestrator", action: "merge", reason: "merged" }],
    } satisfies AttemptTransition;
  },
};

describe("consume", () => {
  test("an attempt input is applied with its intents, a scheduler pass and a run notice; a redelivery is a duplicate", async () => {
    const t = await seeded();
    const msg: QueueMessage = { group: `att:${t.attempt.attemptId}`, input: { kind: "start" }, inputId: "in-merge" };
    const r = await consume(t.deps, msg, mergeMachine);
    expect(r.outcome).toBe("applied");
    const effects = r.intents.map((i) => i.effect + ":" + i.key);
    expect(effects).toContain(`rovara.close:${t.attempt.attemptId}.close`);
    expect(effects.some((e) => e.startsWith("queue.enqueue:sched:acme/mono:"))).toBe(true);
    expect(effects).toContain(`queue.enqueue:fin:${t.run.runId}:US1`);
    const run = await t.deps.repos.getRun(t.run.runId);
    expect(run?.counts.merged).toBe(1);
    expect(run?.counts.running).toBe(0);
    expect((await consume(t.deps, msg, mergeMachine)).outcome).toBe("duplicate");
  });

  test("nothing in the consumer sends to the queue directly", async () => {
    const t = await seeded();
    await consume(t.deps, { group: `att:${t.attempt.attemptId}`, input: { kind: "start" }, inputId: "in-q" }, mergeMachine);
    expect(t.queued).toHaveLength(0);
  });

  test("a version conflict is retried from a fresh read", async () => {
    const t = await seeded();
    let calls = 0;
    const racing: Machines = {
      ...DEFAULT_MACHINES,
      attempt: (ctx) => {
        calls++;
        return { attempt: { ...ctx.attempt, fixRequests: ctx.attempt.fixRequests + 1 }, intents: [], decisions: [] };
      },
    };
    // Bump the attempt's version underneath the first try.
    const original = t.deps.repos.getAttempt.bind(t.deps.repos);
    let bumped = false;
    t.deps.repos.getAttempt = async (id: string) => {
      const a = await original(id);
      if (!bumped && a) {
        bumped = true;
        await t.deps.table.transact([{ kind: "update", key: keys.attempt(id), set: { rovaraTaskUrl: "x" }, expectedVersion: a.version }]);
      }
      return a;
    };
    const r = await consume(t.deps, { group: `att:${t.attempt.attemptId}`, input: { kind: "start" }, inputId: "in-race" }, racing);
    expect(r.outcome).toBe("applied");
    expect(calls).toBe(2);
    expect((await t.deps.repos.getAttempt(t.attempt.attemptId))?.fixRequests).toBe(1);
  });

  test("an input for a missing attempt is reported as missing", async () => {
    const t = await testDeps("consumer-missing");
    cleanup = t.cleanup;
    expect((await consume(t.deps, { group: "att:att_nope", input: { kind: "start" }, inputId: "x" })).outcome).toBe("missing");
  });

  test("a run transition that changes the run's state also asks for a scheduler pass", async () => {
    const t = await seeded();
    const pause: Machines = {
      ...DEFAULT_MACHINES,
      run: (ctx) => ({ run: { ...ctx.run, state: "paused", pausedFor: "operator" }, intents: [], decisions: [{ actor: "op_1", action: "pause", reason: "test" }] }),
    };
    const r = await consume(t.deps, { group: `run:${t.run.runId}`, input: { kind: "pause", by: "op_1", reason: "test", decisionId: "d1" }, inputId: "in-pause" }, pause);
    expect(r.intents.some((i) => i.key.startsWith("sched:acme/mono:"))).toBe(true);
    expect((await t.deps.repos.getRun(t.run.runId))?.state).toBe("paused");
  });
});
