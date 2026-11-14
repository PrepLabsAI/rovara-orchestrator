import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { emptyRepository, type NodeState } from "../../model.js";
import { aDagNode, aNode, aRun, aSettings } from "../../testing/fixtures.js";
import { pick } from "../pick.js";
import type { Candidate, Snapshot } from "../types.js";

/** A random DAG: node i may depend only on nodes before it, so it is acyclic by construction. */
const dagArb = fc
  .record({
    size: fc.integer({ min: 1, max: 25 }),
    concurrency: fc.integer({ min: 1, max: 8 }),
    free: fc.option(fc.integer({ min: 0, max: 10 }), { nil: null }),
    seed: fc.array(fc.tuple(fc.nat(), fc.nat(), fc.boolean(), fc.constantFrom<NodeState>("waiting", "eligible", "running", "merged", "skipped", "escalated"), fc.boolean(), fc.constantFrom("P1", "P2", "P3"))),
  })
  .map(({ size, concurrency, free, seed }) => {
    const run = aRun({ concurrencyLimit: concurrency });
    const candidates: Candidate[] = [];
    const states = new Map<string, NodeState>();
    for (let i = 0; i < size; i++) {
      const [a, b, hasDep, state, mvp, priority] = seed[i % Math.max(1, seed.length)] ?? [0, 0, false, "waiting", false, "P1"];
      const deps = hasDep && i > 0 ? [...new Set([`N${a % i}`, `N${b % i}`])] : [];
      const nodeId = `N${i}`;
      const node = aNode({ runId: run.runId, nodeId, state });
      states.set(`${run.runId}/${nodeId}`, state);
      candidates.push({ run, node, dagNode: aDagNode({ nodeId, dependsOn: deps, order: i, mvp, priority, doneAtImport: state === "merged" && i % 2 === 0 }) });
    }
    const active = [...states.values()].filter((s) => s === "running").length;
    const snapshot: Snapshot = {
      now: "2026-11-11T00:00:00.000Z",
      settings: aSettings(),
      repo: { ...emptyRepository(run.repo), rovaraFreeWorkspaces: free },
      candidates: candidates.filter((c) => !["merged", "skipped", "cancelled"].includes(c.node.state)),
      nodeStates: states,
      activeByRun: new Map([[run.runId, active]]),
      heldFiles: new Map(),
      startedThisMinute: 0,
    };
    return { snapshot, concurrency, free, active, states, run };
  });

describe("scheduler eligibility (properties over 10,000 random DAGs)", () => {
  test("no node starts unless every dependency is merged or skipped", () => {
    fc.assert(
      fc.property(dagArb, ({ snapshot, states, run }) => {
        for (const c of pick(snapshot).starts) {
          for (const d of c.dagNode.dependsOn) {
            const s = states.get(`${run.runId}/${d}`);
            if (s !== "merged" && s !== "skipped") return false;
          }
        }
        return true;
      }),
      { numRuns: 10_000 },
    );
  });

  test("starts never exceed the run's concurrency limit or Rovara's free workspaces", () => {
    fc.assert(
      fc.property(dagArb, ({ snapshot, concurrency, free, active }) => {
        const n = pick(snapshot).starts.length;
        return active + n <= Math.max(active, concurrency) && (free === null || n <= free);
      }),
      { numRuns: 10_000 },
    );
  });

  test("only waiting or eligible nodes start, and held ones say why", () => {
    fc.assert(
      fc.property(dagArb, ({ snapshot }) => {
        const r = pick(snapshot);
        return r.starts.every((c) => c.node.state === "waiting" || c.node.state === "eligible") && r.holds.every((h) => !!h.waitingFor.reason);
      }),
      { numRuns: 10_000 },
    );
  });

  test("order is MVP first, then priority, then DAG order", () => {
    const run = aRun({ concurrencyLimit: 10 });
    const mk = (nodeId: string, order: number, mvp: boolean, priority: string): Candidate => ({ run, node: aNode({ runId: run.runId, nodeId }), dagNode: aDagNode({ nodeId, order, mvp, priority }) });
    const snapshot: Snapshot = {
      now: "t",
      settings: aSettings(),
      repo: emptyRepository(run.repo),
      candidates: [mk("late-p2", 3, false, "P2"), mk("p1", 2, false, "P1"), mk("mvp-p2", 4, true, "P2"), mk("early-p2", 1, false, "P2")],
      nodeStates: new Map(),
      activeByRun: new Map(),
      heldFiles: new Map(),
      startedThisMinute: 0,
    };
    expect(pick(snapshot).starts.map((c) => c.node.nodeId)).toEqual(["mvp-p2", "p1", "early-p2", "late-p2"]);
  });

  test("a node marked done at import counts as merged for its dependents", () => {
    const run = aRun();
    const dep = { run, node: aNode({ runId: run.runId, nodeId: "setup", state: "merged" }), dagNode: aDagNode({ nodeId: "setup", doneAtImport: true }) };
    const child = { run, node: aNode({ runId: run.runId, nodeId: "US1" }), dagNode: aDagNode({ nodeId: "US1", dependsOn: ["setup"], order: 1 }) };
    const snapshot: Snapshot = {
      now: "t",
      settings: aSettings(),
      repo: emptyRepository(run.repo),
      candidates: [child],
      nodeStates: new Map([[`${run.runId}/setup`, dep.node.state], [`${run.runId}/US1`, "waiting"]]),
      activeByRun: new Map(),
      heldFiles: new Map(),
      startedThisMinute: 0,
    };
    expect(pick(snapshot).starts.map((c) => c.node.nodeId)).toEqual(["US1"]);
  });
});
