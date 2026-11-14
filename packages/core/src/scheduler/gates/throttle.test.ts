import { describe, expect, test } from "vitest";
import { emptyRepository } from "../../model.js";
import { aDagNode, aNode, aRun } from "../../testing/fixtures.js";
import type { Candidate, Snapshot } from "../types.js";
import { throttleGate } from "./throttle.js";

const run = aRun();
const candidates: Candidate[] = Array.from({ length: 10 }, (_, i) => ({ run, node: aNode({ runId: run.runId, nodeId: `N${i}`, state: "eligible" }), dagNode: aDagNode({ nodeId: `N${i}`, order: i }) }));
const snap = (startRate: number | null, startedThisMinute: number) => ({ repo: { ...emptyRepository(run.repo), startRate }, startedThisMinute }) as unknown as Snapshot;

describe("throttle gate (FR-063)", () => {
  test("with no rate set, every candidate passes", () => {
    expect(throttleGate(snap(null, 0), candidates).pass).toHaveLength(10);
  });

  test("at most the start rate per minute, counting starts already made this minute; the rest wait for capacity", () => {
    const r = throttleGate(snap(6, 2), candidates);
    expect(r.pass.map((c) => c.node.nodeId)).toEqual(["N0", "N1", "N2", "N3"]);
    expect(r.hold).toHaveLength(6);
    expect(r.hold[0]!.waitingFor).toEqual({ reason: "capacity", detail: "Rovara is throttling starts: at most 6 a minute for now" });
  });

  test("the minute's budget used up: nothing passes", () => {
    expect(throttleGate(snap(6, 6), candidates).pass).toHaveLength(0);
  });
});
