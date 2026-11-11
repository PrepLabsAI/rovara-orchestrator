import { afterEach, describe, expect, test } from "vitest";
import { encodeDag, encodeDagNode, encodeNode, encodeRun } from "@rovara-orch/store";
import { aDag, aDagNode, aNode, aRun } from "@rovara-orch/store/testing";
import { runSchedulerPass } from "./scheduler.js";
import { testDeps } from "./testing/deps.js";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => cleanup?.());

async function seeded(nodeCount: number, concurrency: number) {
  const t = await testDeps("scheduler");
  cleanup = t.cleanup;
  const run = aRun({ concurrencyLimit: concurrency, counts: { waiting: nodeCount } });
  const ops = [
    { kind: "put" as const, item: encodeDag(aDag({ nodeCount })) },
    { kind: "put" as const, item: encodeRun(run) },
  ];
  for (let i = 0; i < nodeCount; i++) {
    ops.push({ kind: "put", item: encodeDagNode(aDagNode({ nodeId: `N${i}`, order: i })) });
    ops.push({ kind: "put", item: encodeNode(aNode({ nodeId: `N${i}` })) });
  }
  await t.deps.table.transact(ops);
  return { ...t, run };
}

describe("runSchedulerPass", () => {
  test("starts nodes up to the run's concurrency, each with an attempt and a start input", async () => {
    const t = await seeded(5, 2);
    const intents = await runSchedulerPass(t.deps, "acme/mono");
    expect(intents).toHaveLength(2);
    expect(intents.every((i) => i.effect === "queue.enqueue" && i.key.startsWith("start:att_"))).toBe(true);
    const nodes = await t.deps.repos.getRunNodes(t.run.runId);
    const running = nodes.filter((n) => n.state === "running");
    expect(running).toHaveLength(2);
    const attempt = await t.deps.repos.getAttempt(running[0]!.currentAttempt!);
    expect(attempt?.phase).toBe("starting");
    expect(attempt?.baseCommit).toBe("b".repeat(40));
    expect(attempt?.due.quietAt).toBe("2026-11-11T00:30:00.000Z");
    const held = nodes.filter((n) => n.state === "eligible");
    expect(held).toHaveLength(3);
    expect(held[0]?.waitingFor?.reason).toBe("capacity");
    const run = await t.deps.repos.getRun(t.run.runId);
    expect(run?.counts.running).toBe(2);
  });

  test("of two concurrent passes, only one acts", async () => {
    const t = await seeded(4, 4);
    const [a, b] = await Promise.all([runSchedulerPass(t.deps, "acme/mono"), runSchedulerPass(t.deps, "acme/mono")]);
    expect(a.length + b.length).toBe(4);
    expect(Math.min(a.length, b.length)).toBe(0);
    const nodes = await t.deps.repos.getRunNodes(t.run.runId);
    expect(nodes.every((n) => n.attempts === 1)).toBe(true);
  });

  test("a second pass starts nothing new while capacity is used", async () => {
    const t = await seeded(3, 1);
    expect(await runSchedulerPass(t.deps, "acme/mono")).toHaveLength(1);
    expect(await runSchedulerPass(t.deps, "acme/mono")).toHaveLength(0);
  });
});
