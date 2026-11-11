import { afterEach, describe, expect, test } from "vitest";
import { createHarness, type Harness } from "./harness.js";

let h: Harness | undefined;
afterEach(async () => h?.drop());

describe("Harness (with the platform's stub handlers)", () => {
  test("a run's start reaches the scheduler, which starts every eligible node in its own attempt", async () => {
    h = await createHarness({ name: "harness-smoke" });
    const dagId = await h.seedDag([{ nodeId: "A" }, { nodeId: "B" }, { nodeId: "C" }]);
    const runId = await h.startRun(dagId, { concurrency: 2 });
    await h.runUntil(async () => h!.consumed.filter((c) => c.inputId.startsWith("start:att_")).length === 2, { maxIdle: 3 });
    const nodes = await h.repos.getRunNodes(runId);
    expect(nodes.filter((n) => n.state === "running")).toHaveLength(2);
    // Start inputs reached each attempt; the stub attempt machine changes nothing yet.
    expect(h.consumed.filter((c) => c.inputId.startsWith("start:att_")).length).toBe(2);
  }, 30_000);

  test("a delivery pipe with faults injects them and counts them", async () => {
    h = await createHarness({ name: "harness-faults", faults: { duplicate: 0.5, delay: 0.5, drop: 0.3, reorder: 0.5 }, seed: 3 });
    for (let i = 0; i < 5; i++) h.github.breakMain();
    for (let i = 0; i < 20; i++) await h.step();
    const counts = h.faultCounts();
    expect(counts.duplicate + counts.delay + counts.drop + counts.reorder).toBeGreaterThan(0);
  }, 30_000);
});
