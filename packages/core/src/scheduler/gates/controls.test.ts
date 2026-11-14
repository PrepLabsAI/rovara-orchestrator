import { describe, expect, test } from "vitest";
import { emptyRepository } from "../../model.js";
import { aDagNode, aNode, aRun, aSettings } from "../../testing/fixtures.js";
import { pick } from "../pick.js";
import type { Snapshot } from "../types.js";
import { controlsGate } from "./controls.js";

function snapshot(p: { stop?: boolean; state?: "running" | "paused"; cost?: number } = {}): Snapshot {
  const run = aRun({ state: p.state ?? "running", costUsd: p.cost ?? 0, costLimitUsd: 10 });
  return {
    now: "t",
    settings: aSettings(p.stop ? { stopSwitch: { on: true, by: "op", at: "t", reason: "x" } } : {}),
    repo: emptyRepository(run.repo),
    candidates: [{ run, node: aNode({ runId: run.runId }), dagNode: aDagNode() }],
    nodeStates: new Map(),
    activeByRun: new Map(),
    heldFiles: new Map(),
    startedThisMinute: 0,
  };
}

describe("controls gate", () => {
  test("passes everything when nothing holds the run", () => {
    const s = snapshot();
    expect(controlsGate(s, s.candidates).pass).toHaveLength(1);
    expect(pick(s).starts).toHaveLength(1);
  });

  test.each<[string, Parameters<typeof snapshot>[0], string]>([
    ["the stop switch is on", { stop: true }, "paused"],
    ["the run is paused", { state: "paused" }, "paused"],
    ["the run is over its cost limit", { cost: 10 }, "cost"],
  ])("holds every node while %s", (_why, p, reason) => {
    const s = snapshot(p);
    const r = controlsGate(s, s.candidates);
    expect(r.pass).toHaveLength(0);
    expect(r.hold.map((h) => h.waitingFor.reason)).toEqual([reason]);
    expect(pick(s).starts).toHaveLength(0);
  });
});
