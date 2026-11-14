import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DevIdentity } from "@rovara-orch/identity";
import { createTable, deleteTable, Repositories, Table } from "@rovara-orch/store";
import { handle, match } from "./router.js";
import { recordAndEnqueue } from "./record-and-enqueue.js";
import type { ApiDeps, Route } from "./types.js";

const endpoint = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";
const tableName = `t-api-${process.pid}-${Date.now()}`;
let deps: ApiDeps;
let aliceToken: string;
let eveToken: string;

beforeAll(async () => {
  await createTable(tableName, endpoint);
  const table = new Table({ tableName, endpoint });
  const identity = new DevIdentity({
    stage: "test",
    signingKey: "k",
    operators: [{ id: "dev_alice", name: "Alice", admin: false }, { id: "dev_eve", name: "Eve", admin: false }],
  });
  aliceToken = (await identity.login("dev_alice")).token;
  eveToken = (await identity.login("dev_eve")).token;
  // Eve has a valid token but is no longer an operator.
  const access = identity.access.bind(identity);
  identity.access = async (op) => (op.id === "dev_eve" ? { isOperator: false, isAdmin: false } : access(op));
  deps = {
    table,
    repos: new Repositories(table),
    identity,
    clock: { now: () => new Date("2026-11-11T00:00:00.000Z") },
    github: { commitOnRemote: async () => true },
    rovara: { linkUrl: async () => null, isLinked: async () => true },
    config: { statusPageUrl: "https://status.test" },
  };
});
afterAll(() => deleteTable(tableName, endpoint));

const req = (method: string, path: string, token?: string, extra: Record<string, string> = {}) => ({
  method,
  path,
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
  query: {},
  body: undefined,
});

describe("operator API frame", () => {
  test("matches path params", () => {
    expect(match("/v1/runs/:runId/nodes/:nodeId", "/v1/runs/run_1/nodes/US1")).toEqual({ runId: "run_1", nodeId: "US1" });
    expect(match("/v1/runs/:runId", "/v1/runs/run_1/pause")).toBeUndefined();
  });

  test("unknown routes are 404 once authenticated", async () => {
    const r = await handle(deps, req("GET", "/v1/nope", aliceToken));
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  test("refuses missing tokens and non-operators, and records each refusal", async () => {
    const anon = await handle(deps, req("GET", "/v1/runs/run_1/nodes/US1"));
    expect(anon).toMatchObject({ status: 401, body: { error: { code: "AUTH_REQUIRED" } } });
    const eve = await handle(deps, req("GET", "/v1/runs/run_1/nodes/US1", eveToken));
    expect(eve).toMatchObject({ status: 403, body: { error: { code: "NOT_OPERATOR" } } });
    const refusals = await deps.table.query<{ action: string; actor: string }>("DECISIONS#GLOBAL", "DEC#");
    expect(refusals.map((r) => `${r.action}:${r.actor}`)).toEqual(expect.arrayContaining(["refused:anonymous", "refused:dev_eve"]));
  });

  test("recordAndEnqueue writes the decision and one enqueue intent; a retry with the same Idempotency-Key returns the first result", async () => {
    const route: Route = {
      method: "POST",
      pattern: "/v1/runs/:runId/pause",
      handler: (ctx) =>
        recordAndEnqueue(ctx, {
          runId: ctx.params.runId!,
          decision: { actor: ctx.operator.id, action: "pause", reason: "test" },
          message: { group: `run:${ctx.params.runId}`, input: { kind: "pause", by: ctx.operator.id, reason: "test", decisionId: "x" } },
        }),
    };
    const r1 = await handle(deps, req("POST", "/v1/runs/run_9/pause", aliceToken, { "Idempotency-Key": "abc" }), [route]);
    const r2 = await handle(deps, req("POST", "/v1/runs/run_9/pause", aliceToken, { "Idempotency-Key": "abc" }), [route]);
    expect(r1.status).toBe(202);
    expect(r2).toEqual(r1);
    const intents = await deps.table.query<{ key: string }>("RUN#run_9", "INTENT#");
    expect(intents.map((i) => i.key)).toEqual(["api:dev_alice:abc"]);
    expect(await deps.repos.listDecisions("run_9")).toHaveLength(1);
  });
});
