import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { emptyRepository, type NodeState } from "../../model.js";
import { aDagNode, aNode, aRun, aSettings } from "../../testing/fixtures.js";
import { pick } from "../pick.js";
import type { Candidate, Snapshot } from "../types.js";
import { fileLocksGate } from "./file-locks.js";

const POOL = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/", "docs/"];
const listed = (files: string[]) => files.filter((f) => !f.endsWith("/"));

/** Two runs on one repository; running nodes hold their files (as the store's lock items say). */
const arb = fc
  .array(fc.record({ run: fc.integer({ min: 0, max: 1 }), files: fc.subarray(POOL, { maxLength: 3 }), state: fc.constantFrom<NodeState>("waiting", "eligible", "running") }), { minLength: 1, maxLength: 20 })
  .map((specs) => {
    const runs = [aRun({ runId: "run_01AAAAAAAAAAAAAAAAAAAAAAAA", concurrencyLimit: 50, startedAt: "2026-11-11T00:00:00.000Z" }), aRun({ runId: "run_01BBBBBBBBBBBBBBBBBBBBBBBB", concurrencyLimit: 50, startedAt: "2026-11-11T00:01:00.000Z" })];
    const held = new Map<string, { runId: string; nodeId: string }>();
    const candidates: Candidate[] = specs.map((s, i) => {
      const run = runs[s.run]!;
      const nodeId = `N${i}`;
      let state = s.state;
      if (state === "running") {
        if (listed(s.files).some((f) => held.has(f))) state = "eligible";
        else for (const f of listed(s.files)) held.set(f, { runId: run.runId, nodeId });
      }
      return { run, node: aNode({ runId: run.runId, nodeId, state }), dagNode: aDagNode({ nodeId, files: s.files, order: i, dependsOn: [] }) };
    });
    const snapshot: Snapshot = {
      now: "2026-11-11T00:00:00.000Z",
      settings: aSettings(),
      repo: emptyRepository(runs[0]!.repo),
      candidates,
      nodeStates: new Map(candidates.map((c) => [`${c.run.runId}/${c.node.nodeId}`, c.node.state])),
      activeByRun: new Map(runs.map((r) => [r.runId, candidates.filter((c) => c.run.runId === r.runId && c.node.state === "running").length])),
      heldFiles: held,
    };
    return { snapshot, candidates };
  });

describe("file locks (properties over 10,000 random cases)", () => {
  test("across all runs on a repository, no two running nodes share a listed file", () => {
    fc.assert(
      fc.property(arb, ({ snapshot, candidates }) => {
        const started = new Set(pick(snapshot).starts.map((c) => `${c.run.runId}/${c.node.nodeId}`));
        const running = candidates.filter((c) => c.node.state === "running" || started.has(`${c.run.runId}/${c.node.nodeId}`));
        const seen = new Set<string>();
        for (const c of running) {
          for (const f of listed(c.dagNode.files)) {
            expect(seen.has(f), f).toBe(false);
            seen.add(f);
          }
        }
      }),
      { numRuns: 10_000 },
    );
  });

  test("paths ending in / are ignored, and a held node waits with the reason files", () => {
    const run = aRun();
    const c = (nodeId: string, files: string[]): Candidate => ({ run, node: aNode({ runId: run.runId, nodeId, state: "eligible" }), dagNode: aDagNode({ nodeId, files }) });
    const snapshot = {
      heldFiles: new Map([["src/a.ts", { runId: run.runId, nodeId: "OTHER" }]]),
    } as unknown as Snapshot;
    const r = fileLocksGate(snapshot, [c("DIR", ["src/"]), c("A", ["src/a.ts"]), c("B", ["src/b.ts", "src/"]), c("B2", ["src/b.ts"])]);
    expect(r.pass.map((x) => x.node.nodeId)).toEqual(["DIR", "B"]);
    expect(r.hold.map((h) => [h.candidate.node.nodeId, h.waitingFor.reason, h.waitingFor.detail])).toEqual([
      ["A", "files", "src/a.ts (held by OTHER)"],
      ["B2", "files", "src/b.ts (held by B)"],
    ]);
  });

  test("a node's own lock (from an earlier attempt) does not hold it", () => {
    const run = aRun();
    const snapshot = { heldFiles: new Map([["src/a.ts", { runId: run.runId, nodeId: "A" }]]) } as unknown as Snapshot;
    const r = fileLocksGate(snapshot, [{ run, node: aNode({ runId: run.runId, nodeId: "A", state: "eligible" }), dagNode: aDagNode({ nodeId: "A", files: ["src/a.ts"] }) }]);
    expect(r.pass).toHaveLength(1);
  });
});
