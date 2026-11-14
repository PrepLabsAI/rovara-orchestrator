import { describe, expect, test } from "vitest";
import { emptyRepository, type Repository } from "../../model.js";
import { aDagNode, aNode, anAttemptContext, aRun, aRunContext, aSettings } from "../../testing/fixtures.js";
import { pick } from "../../scheduler/pick.js";
import type { Snapshot } from "../../scheduler/types.js";
import { attemptMachine } from "../attempt.js";
import { repositoryMachine } from "../repository.js";
import { runMachine } from "../run.js";

const repo = (p: Partial<Repository> = {}): Repository => ({ ...emptyRepository("acme/mono"), ...p });

describe("run start against Rovara's project limit (FR-061)", () => {
  test("concurrency above the limit asks Rovara to raise it when the acting-for operator is a Rovara administrator", () => {
    const ctx = aRunContext({ run: aRun({ concurrencyLimit: 1000, actingFor: "dev_admin" }), repo: repo({ rovaraProjectLimit: 200 }), actingForIsAdmin: true });
    const t = runMachine(ctx, { kind: "run_start" })!;
    expect(t.intents.map((i) => i.effect)).toEqual(["rovara.workspace_limit"]);
    expect(t.intents[0]!.payload).toMatchObject({ repo: "acme/mono", openWorkspaces: 1000, by: "dev_admin" });
    expect(t.decisions).toEqual([expect.objectContaining({ actor: "orchestrator", reason: expect.stringContaining("200") })]);
  });

  test("otherwise the run starts at the current limit, and nodes wait with the reason capacity and the message", () => {
    const ctx = aRunContext({ run: aRun({ concurrencyLimit: 1000 }), repo: repo({ rovaraProjectLimit: 2 }), actingForIsAdmin: false });
    const t = runMachine(ctx, { kind: "run_start" });
    expect(t?.intents.filter((i) => i.effect === "rovara.workspace_limit") ?? []).toHaveLength(0);

    const run = aRun({ concurrencyLimit: 1000 });
    const candidates = Array.from({ length: 5 }, (_, i) => ({ run, node: aNode({ runId: run.runId, nodeId: `N${i}`, state: "eligible" as const }), dagNode: aDagNode({ nodeId: `N${i}`, order: i }) }));
    const snapshot: Snapshot = { now: "t", settings: aSettings(), repo: repo({ rovaraProjectLimit: 2, rovaraFreeWorkspaces: 2 }), candidates, nodeStates: new Map(), activeByRun: new Map(), heldFiles: new Map(), startedThisMinute: 0 };
    const r = pick(snapshot);
    expect(r.starts).toHaveLength(2);
    expect(r.holds.map((h) => h.waitingFor)).toEqual(Array(3).fill({ reason: "capacity", detail: "Rovara's project limit is 2; an administrator can raise it" }));
  });

  test("within the limit, or with the limit unknown (until Rovara#430), nothing is asked", () => {
    expect(runMachine(aRunContext({ run: aRun({ concurrencyLimit: 100 }), repo: repo({ rovaraProjectLimit: 200 }), actingForIsAdmin: true }), { kind: "run_start" })?.intents.filter((i) => i.effect === "rovara.workspace_limit") ?? []).toHaveLength(0);
    expect(runMachine(aRunContext({ run: aRun({ concurrencyLimit: 100 }), repo: repo(), actingForIsAdmin: true }), { kind: "run_start" })?.intents.filter((i) => i.effect === "rovara.workspace_limit") ?? []).toHaveLength(0);
  });
});

describe("Rovara refusing a start (FR-062, FR-063)", () => {
  const limitError = { kind: "rovara", type: "error", eventId: "evt_wl00000000000000000001", createdAt: "t", data: { code: "workspace_limit", text: "The workspace limit is reached." } } as const;

  test("a workspace-limit refusal returns the node to waiting without using an attempt, and tells the repository", () => {
    const base = anAttemptContext();
    const ctx = { ...base, attempt: { ...base.attempt, phase: "starting" as const }, node: { ...base.node, state: "running" as const, attempts: 1 } };
    const t = attemptMachine(ctx, limitError)!;
    expect(t.node).toMatchObject({ state: "waiting", waitingFor: { reason: "capacity" }, refusedStarts: 1 });
    expect(t.attempt).toMatchObject({ phase: "abandoned", outcomeReason: "workspace_limit" });
    const told = t.intents.find((i) => i.effect === "queue.enqueue")!;
    expect(told.payload.messages).toEqual([expect.objectContaining({ group: `repo:${ctx.run.repo}`, input: { kind: "workspace_limit_hit" } })]);
    expect(t.decisions).toHaveLength(0);
  });

  test("a refused start does not count toward the node's attempts", () => {
    const base = anAttemptContext({ run: aRun({ retry: { fixRequests: 0, attempts: 1, prUpdates: 1, reviewRounds: 1, quietMinutes: 30 } }) });
    // Attempt 2 is the node's first real attempt: attempt 1 was refused for the workspace limit.
    const ctx = { ...base, attempt: { ...base.attempt, n: 2, phase: "coding" as const }, node: { ...base.node, state: "running" as const, attempts: 2, refusedStarts: 1 } };
    const t = attemptMachine(ctx, { kind: "rovara", type: "error", eventId: "evt_x0000000000000000000001", createdAt: "t", data: { code: "internal", text: "boom" } })!;
    expect(t.node?.state).toBe("escalated"); // out of its one real attempt, not of two
  });

  test("the repository holds starts for a minute after a refusal", () => {
    const t = repositoryMachine({ now: "2026-11-11T01:00:00.000Z", repo: repo(), runs: [], settings: aSettings() }, { kind: "workspace_limit_hit" })!;
    expect(t.repo).toMatchObject({ rovaraFreeWorkspaces: 0, workspaceLimitAt: "2026-11-11T01:00:00.000Z" });
  });

  test("a 5-minute window is turned into the next start rate once", () => {
    const ctx = { now: "t", repo: repo({ startRate: null }), runs: [], settings: aSettings() };
    const t = repositoryMachine(ctx, { kind: "rate_window", window: 7, requests: 100, throttled: 30, concurrencyLimit: 1000 })!;
    expect(t.repo).toMatchObject({ startRate: 500, rateWindow: 7 });
    expect(repositoryMachine({ ...ctx, repo: t.repo! }, { kind: "rate_window", window: 7, requests: 100, throttled: 30, concurrencyLimit: 1000 })).toBeUndefined();
  });
});
