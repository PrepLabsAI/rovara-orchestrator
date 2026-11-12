import { describe, expect, test } from "vitest";
import { validateDag } from "@rovara-orch/dag-import";
import { buildLoadDag, loadEnv, runLoad } from "./driver.js";

describe("the load DAG", () => {
  test("is a valid speckit-dag file: 1200 nodes, Foundational then 1199 stories", async () => {
    const dag = buildLoadDag(1200);
    const r = await validateDag(dag, { commitOnRemote: async () => true });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect((dag.nodes as unknown[]).length).toBe(1200);
  });
});

describe.skipIf(process.env.LOAD !== "1")("load stage: 1200 nodes at concurrency 1000 (SC-003, SC-007, SC-009)", () => {
  test("reaches 1000 concurrent nodes, starts eligible nodes fast, and loses or doubles none", async () => {
    const r = await runLoad(loadEnv(), { nodes: 1200, concurrency: 1000, timeoutMs: 3 * 60 * 60_000 });
    console.log(JSON.stringify(r));
    expect(r.peakActive, "SC-007: 1000 concurrent nodes").toBeGreaterThanOrEqual(1000);
    expect(r.startedWithin60s / r.capacity, "SC-003: 95% started within 60 s").toBeGreaterThanOrEqual(0.95);
    expect(r.merged, "SC-007: no node lost").toBe(r.nodes);
    expect(r.conversations, "SC-007: no node started twice").toBe(r.nodes);
    if (r.traceLatencyP95Ms !== null) expect(r.traceLatencyP95Ms + 2_000, "SC-009").toBeLessThanOrEqual(10_000);
    if (r.versionConflictShare !== null) expect(r.versionConflictShare, "version-conflict retries").toBeLessThan(0.01);
  });
});
