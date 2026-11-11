import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { handle, type ApiDeps } from "@rovara-orch/api";
import { DevIdentity } from "@rovara-orch/identity";
import { freshTable } from "@rovara-orch/testkit";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../contract/fixtures/speckit-dag/${name}.json`, import.meta.url), "utf8"));

let deps: ApiDeps;
let token: string;
let drop: () => Promise<void>;

beforeAll(async () => {
  const t = await freshTable("dag-import");
  drop = t.drop;
  const identity = new DevIdentity({ stage: "test", signingKey: "k", operators: [{ id: "dev_alice", name: "Alice", admin: false }] });
  token = (await identity.login("dev_alice")).token;
  deps = {
    table: t.table,
    repos: t.repos,
    identity,
    clock: { now: () => new Date("2026-11-11T00:00:00.000Z") },
    github: { commitOnRemote: async () => true },
    rovara: { linkUrl: async () => null, isLinked: async () => true },
    config: { statusPageUrl: "https://status.test" },
  };
});
afterAll(() => drop());

const call = (method: string, path: string, body?: unknown) =>
  handle(deps, { method, path, headers: { authorization: `Bearer ${token}` }, query: {}, body });

describe("DAG import through the operator API", () => {
  let dagId: string;

  test("a first import returns 201 with a dag-id", async () => {
    const r = await call("POST", "/v1/dags", fixture("units"));
    expect(r.status).toBe(201);
    const body = r.body as { dagId: string; hash: string; created: boolean };
    expect(body).toMatchObject({ hash: fixture("units").hash, created: true });
    expect(body.dagId).toMatch(/^dag_/);
    dagId = body.dagId;
  });

  test("the same file returns 200 with the same dag-id, and nothing new is stored", async () => {
    const r = await call("POST", "/v1/dags", fixture("units"));
    expect(r).toEqual({ status: 200, body: { dagId, hash: fixture("units").hash, created: false } });
    expect(await deps.repos.listDags()).toHaveLength(1);
  });

  test("an edited copy (committed and pushed) gets a new dag-id", async () => {
    const edited = { ...fixture("edited"), spec: { ...fixture("edited").spec, repo: "git@github.com:ps06756/speckit-dag.git", pushed: true } };
    const r = await call("POST", "/v1/dags", edited);
    expect(r.status).toBe(201);
    expect((r.body as { dagId: string }).dagId).not.toBe(dagId);
  });

  test("a refused file answers 422 with the problem", async () => {
    const r = await call("POST", "/v1/dags", fixture("dirty-edited"));
    expect(r).toMatchObject({ status: 422, body: { error: { code: "INVALID", problem: "spec_dirty" } } });
  });

  test("list and show return the stored fields", async () => {
    const list = (await call("GET", "/v1/dags")).body as { items: Array<Record<string, unknown>> };
    expect(list.items).toHaveLength(2);
    expect(Object.keys(list.items[0]!).sort()).toEqual(["commit", "dagId", "feature", "hash", "importedAt", "importedBy", "nodeCount", "repo"].sort());
    const show = (await call("GET", `/v1/dags/${dagId}`)).body as { dagId: string; nodes: Array<{ nodeId: string }>; edges: unknown[] };
    expect(show.dagId).toBe(dagId);
    expect(show.nodes.map((n) => n.nodeId)).toEqual(["setup", "foundational", "US1", "US2", "US3", "polish"]);
    expect(show.edges.length).toBeGreaterThan(0);
    expect((await call("GET", "/v1/dags/dag_nope")).status).toBe(404);
  });
});
