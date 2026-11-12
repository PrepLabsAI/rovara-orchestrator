import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { emptyRepository } from "@rovara-orch/core";
import { DevIdentity } from "@rovara-orch/identity";
import { createTable, deleteTable, keys, repoFields, Repositories, Table } from "@rovara-orch/store";
import { handle } from "../router.js";
import type { ApiDeps } from "../types.js";

const endpoint = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";
const tableName = `t-repos-${process.pid}-${Date.now()}`;
let deps: ApiDeps;
const tokens: Record<string, string> = {};
const asked: unknown[] = [];

beforeAll(async () => {
  await createTable(tableName, endpoint);
  const table = new Table({ tableName, endpoint });
  const identity = new DevIdentity({ stage: "test", signingKey: "k", operators: [{ id: "dev_alice", name: "Alice", admin: false }, { id: "dev_root", name: "Root", admin: true }] });
  tokens.alice = (await identity.login("dev_alice")).token;
  tokens.root = (await identity.login("dev_root")).token;
  deps = {
    table,
    repos: new Repositories(table),
    identity,
    clock: { now: () => new Date("2026-11-11T00:00:00.000Z") },
    github: { commitOnRemote: async () => true },
    rovara: { linkUrl: async () => null, isLinked: async () => true },
    config: { statusPageUrl: "https://status.test" },
  };
  const repo = { ...emptyRepository("acme/mono"), paused: true, pausedSince: "2026-11-11T00:00:00.000Z", mainCommit: "c".repeat(40), startRate: 250, rovaraFreeWorkspaces: 40 };
  await table.transact([{ kind: "put", item: { ...keys.repo("acme/mono"), ...repoFields(repo), version: 1 } }]);
});
afterAll(() => deleteTable(tableName, endpoint));

const call = (method: string, path: string, who: string, body?: unknown) => handle(deps, { method, path, headers: { Authorization: `Bearer ${tokens[who]}` }, query: {}, body });

describe("repositories (US6)", () => {
  test("GET returns the pause state and capacity", async () => {
    const r = await call("GET", "/v1/repos/acme/mono", "alice");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ repo: "acme/mono", paused: true, pausedSince: "2026-11-11T00:00:00.000Z", mainCommit: "c".repeat(40), startRate: 250, rovaraFreeWorkspaces: 40 });
  });

  test("the workspace-limit request is refused for someone who is not a Rovara administrator", async () => {
    const r = await call("POST", "/v1/repos/acme/mono/workspace-limit", "alice", { openWorkspaces: 1000, openWorkspacesPerPerson: 1000 });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: { code: "NOT_OPERATOR", problem: "not_rovara_admin" } });
  });

  test("for an administrator it answers 501 until Rovara#430, then 202 through Rovara's admin change path", async () => {
    const body = { openWorkspaces: 1000, openWorkspacesPerPerson: 1000 };
    expect((await call("POST", "/v1/repos/acme/mono/workspace-limit", "root", body)).status).toBe(501);
    deps.rovara.requestWorkspaceLimit = async (r) => void asked.push(r);
    expect((await call("POST", "/v1/repos/acme/mono/workspace-limit", "root", body)).status).toBe(202);
    expect(asked).toEqual([{ project: "acme/mono", openWorkspaces: 1000, openWorkspacesPerPerson: 1000, by: "dev_root" }]);
    expect((await call("POST", "/v1/repos/acme/mono/workspace-limit", "root", { openWorkspaces: 0 })).status).toBe(422);
  });
});
