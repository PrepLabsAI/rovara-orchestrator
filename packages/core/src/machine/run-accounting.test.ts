import { describe, expect, test } from "vitest";
import { moveNode } from "./helpers.js";
import { isRunDone, runAccounting } from "./run-accounting.js";
import { runMachine } from "./run.js";
import { aNode, aRun, aRunContext } from "../testing/fixtures.js";

describe("run accounting", () => {
  test("node moves are counter changes: minus one from the old state, plus one to the new", () => {
    expect(moveNode(aNode({ state: "running" }), "pr_open").counters).toEqual({ counts: { running: -1, pr_open: 1 } });
    expect(moveNode(aNode({ state: "running" }), "running").counters).toEqual({});
  });

  test("the run completes, with endedAt, once every node is merged or skipped", () => {
    const run = aRun();
    const nodes = [aNode({ nodeId: "A", state: "merged" }), aNode({ nodeId: "B", state: "skipped" })];
    const t = runMachine(aRunContext({ run, nodes }), { kind: "node_finished", nodeId: "B", state: "skipped" })!;
    expect(t.run).toMatchObject({ state: "complete", endedAt: "2026-11-11T01:00:00.000Z" });
    expect(t.records).toEqual([{ kind: "delete", key: { pk: `DAGRUN#${run.dagId}`, sk: "ACTIVE" } }]);
  });

  test("the run is not done while any node is unfinished or escalated", () => {
    expect(isRunDone([aNode({ state: "merged" }), aNode({ state: "escalated" })])).toBe(false);
    expect(runAccounting(aRunContext({ nodes: [aNode({ state: "merged" }), aNode({ nodeId: "B", state: "running" })] }), { kind: "node_finished", nodeId: "A", state: "merged" })).toBeUndefined();
  });

  test("a cancelled run is never marked complete", () => {
    expect(runAccounting(aRunContext({ run: aRun({ state: "cancelled" }), nodes: [aNode({ state: "merged" })] }), { kind: "node_finished", nodeId: "A", state: "merged" })).toBeUndefined();
  });
});
