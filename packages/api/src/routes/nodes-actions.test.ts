import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Intent, NodeRunState } from "@rovara-orch/core";
import { aNode, aRun } from "@rovara-orch/core/testing";
import { DevIdentity } from "@rovara-orch/identity";
import { createTable, deleteTable, encodeNode, encodeRun, Repositories, Table } from "@rovara-orch/store";
import { handle } from "../router.js";
import type { ApiDeps } from "../types.js";

const endpoint = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";
const tableName = `t-nodes-${process.pid}-${Date.now()}`;
let deps: ApiDeps;
let token: string;
const run = aRun({ runId: "run_01NODEACTIONS0000000000000" });

beforeAll(async () => {
  await createTable(tableName, endpoint);
  const table = new Table({ tableName, endpoint });
  const identity = new DevIdentity({ stage: "test", signingKey: "k", operators: [{ id: "dev_alice", name: "Alice", admin: false }] });
  token = (await identity.login("dev_alice")).token;
  deps = {
    table,
    repos: new Repositories(table),
    identity,
    clock: { now: () => new Date("2026-11-11T00:00:00.000Z") },
    github: { commitOnRemote: async () => true },
    rovara: { linkUrl: async () => null, isLinked: async () => true },
    config: { statusPageUrl: "https://status.test" },
  };
  const node = (nodeId: string, state: NodeRunState["state"]) =>
    encodeNode(aNode({ runId: run.runId, nodeId, state, currentAttempt: `att_${run.runId}.${nodeId}.a3`, attempts: 3 }));
  await table.transact([
    { kind: "put", item: encodeRun(run) },
    { kind: "put", item: node("ESC", "escalated") },
    { kind: "put", item: node("RUN", "running") },
  ]);
});
afterAll(() => deleteTable(tableName, endpoint));

const post = (path: string, body: unknown, key?: string) =>
  handle(deps, { method: "POST", path, headers: { Authorization: `Bearer ${token}`, ...(key ? { "Idempotency-Key": key } : {}) }, query: {}, body });

describe("escalated-node actions (FR-033)", () => {
  test.each(["retry", "skip", "cancel"])("%s works only from escalated: 409 otherwise", async (action) => {
    const r = await post(`/v1/runs/${run.runId}/nodes/RUN/${action}`, { reason: "x" });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: { code: "CONFLICT", problem: "not_escalated" } });
  });

  test.each(["retry", "skip", "cancel"])("%s needs a reason", async (action) => {
    expect((await post(`/v1/runs/${run.runId}/nodes/ESC/${action}`, {})).status).toBe(422);
  });

  test("an unknown node is 404", async () => {
    expect((await post(`/v1/runs/${run.runId}/nodes/NOPE/retry`, { reason: "x" })).status).toBe(404);
  });

  test.each(["retry", "skip", "cancel"])("%s records who and why, and sends the action to the node's attempt", async (action) => {
    const r = await post(`/v1/runs/${run.runId}/nodes/ESC/${action}`, { reason: `fixed the script (${action})` }, `k-${action}`);
    expect(r.status).toBe(202);
    const { decisionId } = r.body as { decisionId: string };
    const decisions = await deps.repos.listDecisions(run.runId);
    expect(decisions).toEqual(expect.arrayContaining([expect.objectContaining({ actor: "dev_alice", action, nodeId: "ESC", reason: `fixed the script (${action})` })]));
    const intents = await deps.table.queryIndex<Intent>("PENDING_INTENT", {});
    const sent = intents.find((i) => i.effect === "queue.enqueue" && JSON.stringify(i.payload).includes(decisionId))!;
    expect((sent.payload as { messages: unknown[] }).messages).toEqual([
      expect.objectContaining({
        group: `att:att_${run.runId}.ESC.a3`,
        input: { kind: "node_action", action, by: "dev_alice", reason: `fixed the script (${action})`, decisionId },
      }),
    ]);
    // The same Idempotency-Key gives the same answer and no second input.
    expect((await post(`/v1/runs/${run.runId}/nodes/ESC/${action}`, { reason: "again" }, `k-${action}`)).body).toEqual(r.body);
  });
});
