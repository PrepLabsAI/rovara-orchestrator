import type { QueueMessage } from "@rovara-orch/core";
import { createTable, deleteTable, Repositories, Table } from "@rovara-orch/store";
import type { Deps } from "../ports.js";

export const ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";

/** Minimal worker dependencies for unit tests: a fresh DynamoDB Local table and an in-memory queue. */
export async function testDeps(name: string, overrides: Partial<Deps> = {}) {
  const tableName = `t-${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await createTable(tableName, ENDPOINT);
  const table = new Table({ tableName, endpoint: ENDPOINT });
  const queued: QueueMessage[] = [];
  let now = new Date("2026-11-11T00:00:00.000Z");
  const deps: Deps = {
    table,
    repos: new Repositories(table),
    clock: { now: () => now },
    queue: { send: async (m) => void queued.push(...m) },
    rovara: { sendMessage: async () => {}, sendDecision: async () => {} },
    github: { mainHead: async () => "b".repeat(40) } as unknown as Deps["github"],
    slack: { post: async () => ({ ts: "1.1" }), reply: async () => ({ ts: "1.2" }) },
    answerer: { answer: async () => { throw new Error("no answerer in this test"); } },
    config: { rovaraTenant: "test", rovaraSpace: "mono", channel: "orchestrator", statusPageUrl: "https://status.test" },
    operators: { isRovaraAdmin: async () => false },
    ...overrides,
  };
  return {
    deps,
    queued,
    setNow: (iso: string) => void (now = new Date(iso)),
    cleanup: () => deleteTable(tableName, ENDPOINT),
  };
}
