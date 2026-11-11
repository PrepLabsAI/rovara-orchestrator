import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { applyTransition, DuplicateInput } from "./apply-transition.js";
import { keys, ownerPk } from "./keys.js";
import { encodeAttempt, encodeNode, encodeRun, Repositories } from "./repositories.js";
import { createTable, deleteTable } from "./schema.js";
import { Table, VersionConflict } from "./table.js";
import { aNode, anAttempt, aRun } from "./testing/fixtures.js";

const endpoint = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";
const tableName = `t-apply-${process.pid}-${Date.now()}`;
let table: Table;
let repos: Repositories;

beforeAll(async () => {
  await createTable(tableName, endpoint);
  table = new Table({ tableName, endpoint });
  repos = new Repositories(table);
});
afterAll(() => deleteTable(tableName, endpoint));

async function seed(runId: string) {
  const run = aRun({ runId, counts: { waiting: 1 } });
  const node = aNode({ runId });
  const attempt = anAttempt({ runId });
  await table.transact([
    { kind: "put", item: encodeRun(run) },
    { kind: "put", item: encodeNode(node) },
    { kind: "put", item: encodeAttempt(attempt) },
  ]);
  return { run, node, attempt };
}

describe("applyTransition", () => {
  test("writes entity updates, intents, decisions and counters in one transaction", async () => {
    const { run, node, attempt } = await seed("run_01APPLY00000000000000000A");
    const now = "2026-11-11T01:00:00.000Z";
    const intents = await applyTransition(table, {
      owner: ownerPk.attempt(attempt.attemptId),
      inputId: "in-1",
      runId: run.runId,
      now,
      before: { attempt, node, run },
      after: {
        attempt: { ...attempt, phase: "planning" },
        node: { ...node, state: "running" },
        intents: [{ effect: "rovara.message", key: `${attempt.attemptId}.brief`, payload: { text: "hi" } }],
        decisions: [{ actor: "orchestrator", action: "approve", reason: "plan approval" }],
        counters: { counts: { waiting: -1, running: 1 }, costUsd: 0.5 },
      },
    });
    expect(intents).toHaveLength(1);
    expect((await repos.getAttempt(attempt.attemptId))?.phase).toBe("planning");
    expect((await repos.getAttempt(attempt.attemptId))?.version).toBe(2);
    const r = await repos.getRun(run.runId);
    expect(r?.counts.running).toBe(1);
    expect(r?.counts.waiting).toBe(0);
    expect(r?.costUsd).toBe(0.5);
    expect(r?.version).toBe(1);
    expect(await repos.listDecisions(run.runId)).toHaveLength(1);
    const pending = await table.queryIndex("PENDING_INTENT");
    expect(pending.some((p) => p.key === `${attempt.attemptId}.brief`)).toBe(true);
  });

  test("a failed version condition writes none of it", async () => {
    const { run, node, attempt } = await seed("run_01APPLY00000000000000000B");
    const stale = { ...attempt, version: 99 };
    await expect(
      applyTransition(table, {
        owner: ownerPk.attempt(attempt.attemptId),
        inputId: "in-2",
        runId: run.runId,
        now: "2026-11-11T01:00:00.000Z",
        before: { attempt: stale, node, run },
        after: {
          attempt: { ...attempt, phase: "planning" },
          node: { ...node, state: "running" },
          intents: [{ effect: "rovara.message", key: "k-b", payload: {} }],
          decisions: [{ actor: "orchestrator", action: "approve", reason: "x" }],
          counters: { counts: { running: 1 } },
        },
      }),
    ).rejects.toBeInstanceOf(VersionConflict);
    expect((await repos.getRunNode(run.runId, node.nodeId))?.state).toBe("waiting");
    expect((await repos.getRun(run.runId))?.counts.running ?? 0).toBe(0);
    expect(await repos.listDecisions(run.runId)).toHaveLength(0);
    expect(await table.get(keys.input(ownerPk.attempt(attempt.attemptId), "in-2"))).toBeUndefined();
  });

  test("the same input twice is a DuplicateInput and changes nothing the second time", async () => {
    const { run, attempt } = await seed("run_01APPLY00000000000000000C");
    const base = {
      owner: ownerPk.attempt(attempt.attemptId),
      inputId: "in-3",
      runId: run.runId,
      now: "2026-11-11T01:00:00.000Z",
    };
    await applyTransition(table, { ...base, before: { attempt }, after: { attempt: { ...attempt, phase: "planning" }, intents: [], decisions: [] } });
    const fresh = (await repos.getAttempt(attempt.attemptId))!;
    await expect(
      applyTransition(table, { ...base, before: { attempt: fresh }, after: { attempt: { ...fresh, phase: "coding" }, intents: [], decisions: [] } }),
    ).rejects.toBeInstanceOf(DuplicateInput);
    expect((await repos.getAttempt(attempt.attemptId))?.phase).toBe("planning");
  });
});
