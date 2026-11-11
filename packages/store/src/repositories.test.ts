import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { keys } from "./keys.js";
import { decodeRun, encodeAttempt, encodeDag, encodeDagNode, encodeRun, Repositories, versionedWrite, settingsFields } from "./repositories.js";
import { createTable, deleteTable } from "./schema.js";
import { ConditionFailed, Table } from "./table.js";
import { aDag, aDagNode, anAttempt, aRun } from "./testing/fixtures.js";
import { DEFAULT_SETTINGS } from "@rovara-orch/core";

const endpoint = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";
const tableName = `t-repos-${process.pid}-${Date.now()}`;
let table: Table;
let repos: Repositories;

beforeAll(async () => {
  await createTable(tableName, endpoint);
  table = new Table({ tableName, endpoint });
  repos = new Repositories(table);
});
afterAll(() => deleteTable(tableName, endpoint));

describe("Repositories", () => {
  test("a DAG's hash identity item can be written only once", async () => {
    const dag = aDag({ dagId: "dag_A" });
    const hashItem = { ...keys.dagHash(dag.repo, dag.hash), dagId: dag.dagId };
    await table.transact([{ kind: "put", item: encodeDag(dag) }, { kind: "put", item: hashItem, ifNotExists: true }]);
    await expect(table.transact([{ kind: "put", item: { ...hashItem, dagId: "dag_B" }, ifNotExists: true }])).rejects.toBeInstanceOf(ConditionFailed);
    expect(await repos.findDagByHash(dag.repo, dag.hash)).toBe("dag_A");
    expect((await repos.getDag("dag_A"))?.hash).toBe(dag.hash);
  });

  test("DAG nodes come back in graph order", async () => {
    await table.transact([
      { kind: "put", item: encodeDagNode(aDagNode({ dagId: "dag_C", nodeId: "US2", order: 2 })) },
      { kind: "put", item: encodeDagNode(aDagNode({ dagId: "dag_C", nodeId: "setup", order: 0 })) },
    ]);
    expect((await repos.getDagNodes("dag_C")).map((n) => n.nodeId)).toEqual(["setup", "US2"]);
  });

  test("a DAG has at most one active run", async () => {
    const item = { ...keys.dagActiveRun("dag_D"), runId: "run_1" };
    await table.transact([{ kind: "put", item, ifNotExists: true }]);
    await expect(table.transact([{ kind: "put", item: { ...item, runId: "run_2" }, ifNotExists: true }])).rejects.toBeInstanceOf(ConditionFailed);
  });

  test("run counters round-trip and active runs are indexed by repository", async () => {
    const run = aRun({ runId: "run_01REPOS0000000000000000001", counts: { running: 3, merged: 2 } });
    await table.transact([{ kind: "put", item: encodeRun(run) }]);
    const back = await repos.getRun(run.runId);
    expect(back?.counts).toMatchObject({ running: 3, merged: 2 });
    expect((await repos.listActiveRuns("acme/mono")).map((r) => r.runId)).toContain(run.runId);
    expect(decodeRun(encodeRun(run)).counts.running).toBe(3);
  });

  test("attempts are indexed by their earliest due time", async () => {
    const a = anAttempt({
      runId: "run_01REPOS0000000000000000002",
      due: { quietAt: "2026-11-11T02:00:00.000Z", reviewAt: "2026-11-11T01:30:00.000Z", retryAt: null },
    });
    await table.transact([{ kind: "put", item: encodeAttempt(a) }]);
    expect((await repos.listDue("2026-11-11T01:00:00.000Z")).map((x) => x.attemptId)).not.toContain(a.attemptId);
    expect((await repos.listDue("2026-11-11T01:31:00.000Z")).map((x) => x.attemptId)).toContain(a.attemptId);
  });

  test("settings and repositories have defaults before they are stored", async () => {
    expect((await repos.getSettings()).reviewToolLogin).toBe("coderabbitai[bot]");
    expect((await repos.getRepo("acme/other")).paused).toBe(false);
    await table.transact([versionedWrite(keys.settings(), settingsFields({ ...DEFAULT_SETTINGS, version: 0, notificationChannel: "C1" }), 0)]);
    const s = await repos.getSettings();
    expect(s.notificationChannel).toBe("C1");
    expect(s.version).toBe(1);
  });
});
