import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTable, deleteTable, intentOps, Repositories, Table } from "@rovara-orch/store";
import type { Intent } from "@rovara-orch/core";
import { backoffMs, MAX_TRIES, runIntent } from "./intent-runner.js";
import type { Deps } from "./ports.js";
import type { Executor } from "./effects/types.js";

const endpoint = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";
const tableName = `t-runner-${process.pid}-${Date.now()}`;
let table: Table;
let now = new Date("2026-11-11T00:00:00.000Z");

beforeAll(async () => {
  await createTable(tableName, endpoint);
  table = new Table({ tableName, endpoint });
});
afterAll(() => deleteTable(tableName, endpoint));

const sent: unknown[] = [];
function deps(): Deps {
  return {
    table,
    repos: new Repositories(table),
    clock: { now: () => now },
    queue: { send: async (m: unknown[]) => void sent.push(...m) },
  } as unknown as Deps;
}

async function writeIntent(key: string, effect = "rovara.message" as Intent["effect"], owner = "ATT#att_x") {
  const { ops, intents } = intentOps(owner, [{ effect, key, payload: {} }], now.toISOString());
  await table.transact(ops);
  return intents[0]!;
}

describe("runIntent", () => {
  test("an intent delivered twice, with a crash between execute and mark-done, reaches the far end once", async () => {
    const farEnd = new Set<string>();
    let calls = 0;
    let crash = true;
    const idempotentSend: Executor = async (intent) => {
      calls++;
      farEnd.add(intent.key); // the far end drops a repeated key, as Rovara does with eventId
      if (crash) {
        crash = false;
        throw new Error("process stopped before mark-done");
      }
      return { ok: true };
    };
    const intent = await writeIntent("k-crash");
    expect(await runIntent(deps(), intent, { "rovara.message": idempotentSend })).toBe("retry");
    expect(await runIntent(deps(), intent, { "rovara.message": idempotentSend })).toBe("done");
    expect(await runIntent(deps(), intent, { "rovara.message": idempotentSend })).toBe("skipped");
    expect(calls).toBe(2);
    expect(farEnd.size).toBe(1);
    const stored = await table.get<Intent>(intent);
    expect(stored?.status).toBe("done");
    expect((stored as unknown as Record<string, unknown>).gsi1pk).toBeUndefined();
  });

  test("a failing intent backs off, then fails after the last try and reports to its owner", async () => {
    const intent = await writeIntent("k-fail");
    const fail: Executor = async () => {
      throw new Error("boom");
    };
    for (let i = 1; i < MAX_TRIES; i++) {
      expect(await runIntent(deps(), intent, { "rovara.message": fail })).toBe("retry");
      const s = await table.get<Intent>(intent);
      expect(s?.tries).toBe(i);
      expect(Date.parse(s!.nextTryAt) - now.getTime()).toBe(backoffMs(i));
    }
    expect(await runIntent(deps(), intent, { "rovara.message": fail })).toBe("failed");
    const report = (await table.queryIndex("PENDING_INTENT")).find((p) => p.key === "failed:k-fail");
    expect(report?.effect).toBe("queue.enqueue");
  });

  test("a queue.enqueue intent run twice puts one message on the queue (deduplicated by input id)", async () => {
    const queued = new Map<string, unknown>();
    const d = { ...deps(), queue: { send: async (msgs: Array<{ inputId: string }>) => msgs.forEach((m) => queued.set(m.inputId, m)) } } as unknown as Deps;
    const { ops, intents } = intentOps("RUN#r", [{ effect: "queue.enqueue", key: "q1", payload: { messages: [{ group: "att:a", input: { kind: "start" }, inputId: "q1" }] } }], now.toISOString());
    await table.transact(ops);
    const crashAfterSend: Executor = async (intent, dd) => {
      await dd.queue.send((intent.payload as { messages: never[] }).messages);
      throw new Error("stopped after send");
    };
    await runIntent(d, intents[0]!, { "queue.enqueue": crashAfterSend });
    await runIntent(d, intents[0]!);
    expect(queued.size).toBe(1);
  });
});
