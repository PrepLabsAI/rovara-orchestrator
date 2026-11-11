import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTable, deleteTable } from "./schema.js";
import { ConditionFailed, mergeOps, Table, VersionConflict, withFreshRead } from "./table.js";

const endpoint = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";
const tableName = `t-table-${process.pid}-${Date.now()}`;
let table: Table;

beforeAll(async () => {
  await createTable(tableName, endpoint);
  table = new Table({ tableName, endpoint });
});
afterAll(() => deleteTable(tableName, endpoint));

describe("Table", () => {
  test("of two concurrent writers with the same expected version, exactly one wins", async () => {
    const key = { pk: "RUN#r1", sk: "META" };
    await table.transact([{ kind: "put", item: { ...key, version: 1, state: "running" }, ifNotExists: true }]);
    const results = await Promise.allSettled([
      table.transact([{ kind: "update", key, set: { state: "paused" }, expectedVersion: 1 }]),
      table.transact([{ kind: "update", key, set: { state: "cancelled" }, expectedVersion: 1 }]),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(VersionConflict);
    const item = await table.get<{ version: number }>(key);
    expect(item?.version).toBe(2);
  });

  test("counter additions need no version and never conflict", async () => {
    const key = { pk: "RUN#r2", sk: "META" };
    await table.transact([{ kind: "put", item: { ...key, version: 1 }, ifNotExists: true }]);
    await Promise.all(Array.from({ length: 10 }, () => table.transact([{ kind: "update", key, add: { c_running: 1 } }])));
    const item = await table.get<{ c_running: number; version: number }>(key);
    expect(item?.c_running).toBe(10);
    expect(item?.version).toBe(1);
  });

  test("a versioned update and an addition on one item merge into one write", async () => {
    const key = { pk: "RUN#r3", sk: "META" };
    await table.transact([{ kind: "put", item: { ...key, version: 1, costUsd: 0 }, ifNotExists: true }]);
    await table.transact([
      { kind: "update", key, set: { state: "paused" }, expectedVersion: 1 },
      { kind: "update", key, add: { costUsd: 2.5 } },
    ]);
    const item = await table.get<{ state: string; costUsd: number; version: number }>(key);
    expect(item).toMatchObject({ state: "paused", costUsd: 2.5, version: 2 });
  });

  test("ifNotExists failures are ConditionFailed, not VersionConflict, and write nothing", async () => {
    const marker = { pk: "EVID#e1", sk: "META" };
    await table.transact([{ kind: "put", item: { ...marker }, ifNotExists: true }]);
    const other = { pk: "ATT#a1", sk: "EV#1" };
    const err = await table
      .transact([
        { kind: "put", item: { ...marker }, ifNotExists: true },
        { kind: "put", item: { ...other, x: 1 } },
      ])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConditionFailed);
    expect(err).not.toBeInstanceOf(VersionConflict);
    expect(await table.get(other)).toBeUndefined();
  });

  test("withFreshRead retries a lost version race", async () => {
    const key = { pk: "RUN#r4", sk: "META" };
    await table.transact([{ kind: "put", item: { ...key, version: 1, n: 0 }, ifNotExists: true }]);
    await Promise.all(
      Array.from({ length: 3 }, () =>
        withFreshRead(async () => {
          const cur = await table.get<{ version: number; n: number }>(key);
          await table.transact([{ kind: "update", key, set: { n: cur!.n + 1 }, expectedVersion: cur!.version }]);
        }, 10),
      ),
    );
    expect((await table.get<{ n: number }>(key))?.n).toBe(3);
  });

  test("mergeOps refuses a put and an update on the same key", () => {
    const key = { pk: "A", sk: "B" };
    expect(() => mergeOps([{ kind: "put", item: { ...key } }, { kind: "update", key, set: { x: 1 } }])).toThrow(/combine/);
  });

  test("query pages by sk prefix", async () => {
    await table.transact(
      Array.from({ length: 5 }, (_, i) => ({ kind: "put" as const, item: { pk: "DAG#d", sk: `NODE#${i}`, i } })),
    );
    expect(await table.query("DAG#d", "NODE#")).toHaveLength(5);
    expect(await table.query("DAG#d", "NODE#", { limit: 2 })).toHaveLength(2);
  });
});
