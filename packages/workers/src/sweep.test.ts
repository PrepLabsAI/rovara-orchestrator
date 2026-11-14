import { afterEach, describe, expect, test } from "vitest";
import { encodeAttempt, encodeRun, intentOps } from "@rovara-orch/store";
import { anAttempt, aRun } from "@rovara-orch/store/testing";
import { runSweep } from "./sweep.js";
import { testDeps } from "./testing/deps.js";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => cleanup?.());

describe("runSweep", () => {
  test("sends timer inputs for due attempts, re-drives old pending intents, and asks for one pass per repository", async () => {
    const t = await testDeps("sweep");
    cleanup = t.cleanup;
    const due = anAttempt({ due: { quietAt: "2026-11-11T00:10:00.000Z", reviewAt: null, retryAt: null } });
    const notDue = anAttempt({ nodeId: "US2", due: { quietAt: "2026-11-11T05:00:00.000Z", reviewAt: null, retryAt: null } });
    await t.deps.table.transact([
      { kind: "put", item: encodeAttempt(due) },
      { kind: "put", item: encodeAttempt(notDue) },
      { kind: "put", item: encodeRun(aRun()) },
      ...intentOps("ATT#att_x", [{ effect: "queue.enqueue", key: "old", payload: { messages: [{ group: "att:att_x", input: { kind: "start" }, inputId: "old" }] } }], "2026-11-11T00:00:00.000Z").ops,
    ]);
    t.setNow("2026-11-11T00:20:00.000Z");
    const r = await runSweep(t.deps);
    expect(r).toEqual({ timers: 1, redriven: 1, passes: 1 });
    const inputIds = t.queued.map((m) => m.inputId);
    expect(inputIds).toContain(`timer:${due.attemptId}:quiet:2026-11-11T00:10:00.000Z`);
    expect(inputIds).toContain("old");
    expect(inputIds.some((i) => i.startsWith("sweep-sched:acme/mono:"))).toBe(true);
  });
});
