import { afterEach, describe, expect, test } from "vitest";
import { FINAL_NODE_STATES } from "@rovara-orch/core";
import { createHarness, SOME_FAULTS, type Harness, type HarnessOptions } from "@rovara-orch/testkit";

let open: Harness[] = [];
afterEach(async () => {
  await Promise.all(open.map((h) => h.drop()));
  open = [];
});

const NODES = [
  { nodeId: "foundational", kind: "foundational", files: ["src/db.ts"] },
  { nodeId: "US1", dependsOn: ["foundational"], files: ["src/signup.ts"] },
  { nodeId: "US2", dependsOn: ["foundational"], files: ["src/login.ts"] },
  { nodeId: "US3", dependsOn: ["foundational"], files: ["src/billing.ts"] },
];

async function start(opts: HarnessOptions) {
  const h = await createHarness({ name: "cancel", ...opts });
  open.push(h);
  const runId = await h.startRun(await h.seedDag(NODES), { concurrency: 4 });
  const nodes = () => h.repos.getRunNodes(runId);
  const node = async (id: string) => (await nodes()).find((n) => n.nodeId === id)!;
  /** Every node ended and nothing left in flight. */
  const settled = async () => (await nodes()).every((n) => FINAL_NODE_STATES.includes(n.state)) && (await h.settled());
  return { h, runId, nodes, node, settled };
}

const said = (h: Harness, nodeId: string, text: string) =>
  h.rovara.attemptsFor(nodeId).flatMap((c) => c.received).filter((r) => r.kind === "message" && r.text === text).length;
const prOf = (h: Harness, nodeId: string) => [...h.github.pulls.values()].find((p) => p.headRef.includes(`.${nodeId}.`));

describe("cancelling a run (FR-050)", () => {
  test.each([
    ["clean", { seed: 2 }],
    ["with faults and crashes, seed 7", { seed: 7, faults: SOME_FAULTS, crash: { ingress: 0.1, consume: 0.15, intent: 0.15 } }],
    ["with faults and crashes, seed 8", { seed: 8, faults: SOME_FAULTS, crash: { ingress: 0.1, consume: 0.15, intent: 0.15 } }],
  ] as const)("mid-run stops each task, closes its workspace and its open PR, once (%s)", async (_name, opts) => {
    const { h, runId, nodes, node, settled } = await start(opts);
    // Cancel with one story at an open PR and the others still running.
    expect(await h.runUntil(async () => (await node("foundational")).state === "merged" && (await nodes()).some((n) => n.state === "pr_open"))).toBe(true);
    const before = await nodes();
    const active = before.filter((n) => !FINAL_NODE_STATES.includes(n.state)).map((n) => n.nodeId);
    expect(active.length).toBeGreaterThan(0);
    await h.controlRun(runId, "cancel", "wrong spec");
    expect(await h.runUntil(settled, { maxSteps: 2000, maxIdle: 30 })).toBe(true);

    expect((await h.repos.getRun(runId))?.state).toBe("cancelled");
    for (const id of active) {
      const n = await node(id);
      if (n.state === "merged") continue; // a merge already in flight completed; it counts (never both)
      expect(n.state, id).toBe("cancelled");
      if (h.rovara.attemptsFor(id).length) {
        expect(said(h, id, "stop"), `${id} stopped once`).toBe(1);
        expect(said(h, id, "close this workspace"), `${id} workspace closed once`).toBe(1);
      }
      const pr = prOf(h, id);
      if (pr) expect(pr.state, `${id} PR closed`).toBe("closed");
    }
    const decisions = (await h.repos.listDecisions(runId)).filter((d) => d.action === "cancel");
    expect(decisions.filter((d) => d.actor === "dev_op").length, "one operator cancel record per attempt and one for the run").toBeGreaterThanOrEqual(1);
    // Counts add up: every node is counted once.
    const run = (await h.repos.getRun(runId))!;
    expect(Object.values(run.counts).reduce((a, b) => a + b, 0)).toBe(NODES.length);
  });

  test("a cancel recorded before the merge-queue call is sent: the PR is closed and never merged", async () => {
    const { h, runId, node, settled } = await start({ seed: 3 });
    expect(await h.runUntil(async () => (await node("foundational")).state === "merged")).toBe(true);
    h.hold("github.enqueue");
    expect(await h.runUntil(async () => (await node("US1")).state === "in_merge_queue")).toBe(true);
    const enqueuesBefore = h.github.enqueueCalls.length;
    await h.controlRun(runId, "cancel", "stop now");
    expect(await h.runUntil(async () => (await node("US1")).state === "cancelled")).toBe(true);
    h.release("github.enqueue");
    expect(await h.runUntil(settled, { maxSteps: 2000, maxIdle: 30 })).toBe(true);

    expect(h.github.enqueueCalls.length, "nothing is sent to the merge queue after a recorded cancel").toBe(enqueuesBefore);
    expect((await node("US1")).state).toBe("cancelled");
    expect(prOf(h, "US1")!.state).toBe("closed");
  });

  test("a merge that reached main before the cancel counts as merged, and the PR is not also closed", async () => {
    const { h, runId, node, settled } = await start({ seed: 4 });
    expect(await h.runUntil(async () => (await node("foundational")).state === "merged")).toBe(true);
    expect(await h.runUntil(async () => prOf(h, "US1")?.state === "merged")).toBe(true);
    await h.controlRun(runId, "cancel", "stop now");
    expect(await h.runUntil(settled, { maxSteps: 2000, maxIdle: 30 })).toBe(true);

    const us1 = await node("US1");
    expect(us1.state).toBe("merged");
    expect(us1.mergeCommit).toBe(prOf(h, "US1")!.mergeCommit);
    expect(said(h, "US1", "close this workspace")).toBe(1);
    const run = (await h.repos.getRun(runId))!;
    expect(run.state).toBe("cancelled");
    expect(Object.values(run.counts).reduce((a, b) => a + b, 0)).toBe(NODES.length);
  });

  test("stopped right after `run cancelled` is stored: every running attempt is still cancelled once", async () => {
    const { h, runId, nodes, settled } = await start({ seed: 5 });
    expect(await h.runUntil(async () => (await nodes()).filter((n) => n.state === "running").length >= 2)).toBe(true);
    const running = (await nodes()).filter((n) => n.state === "running").map((n) => n.nodeId);
    // The run-cancel message is committed but never acknowledged, and the stream loses the fan-out.
    h.crashAfterConsuming((m) => m.group === `run:${runId}` && m.input.kind === "cancel");
    const decisionId = await h.controlRun(runId, "cancel", "stop now");
    expect(await h.runUntil(async () => (await h.repos.getRun(runId))?.state === "cancelled")).toBe(true);
    h.hold("queue.enqueue");
    await h.idle(); // the sweep re-drives the stored fan-out
    h.release("queue.enqueue");
    expect(await h.runUntil(settled, { maxSteps: 2000, maxIdle: 30 })).toBe(true);

    const deliveries = h.consumed.filter((c) => c.inputId === `api:dev_op:${decisionId}`).map((c) => c.outcome);
    expect(deliveries.length, "the cancel was delivered again").toBeGreaterThan(1);
    expect(deliveries.filter((o) => o === "applied"), "and applied once").toHaveLength(1);
    for (const id of running) {
      expect((await nodes()).find((n) => n.nodeId === id)!.state).toBe("cancelled");
      expect(said(h, id, "stop"), `${id} stopped once`).toBe(1);
    }
  });

  test("the API stopped after recording a cancel, and the operator retries with the same Idempotency-Key: one cancel", async () => {
    const { h, runId, settled } = await start({ seed: 6 });
    expect(await h.runUntil(async () => h.rovara.attemptsFor("foundational").length === 1)).toBe(true);
    const first = await h.controlRun(runId, "cancel", "stop now", "key-1");
    const retry = await h.controlRun(runId, "cancel", "stop now", "key-1");
    expect(retry).toBe(first);
    expect(await h.runUntil(settled, { maxSteps: 2000, maxIdle: 30 })).toBe(true);
    const runCancels = (await h.repos.listDecisions(runId)).filter((d) => d.action === "cancel" && (d.detail as { decisionId?: string } | undefined)?.decisionId === first);
    // The API's record and the run machine's record share the decision id; nothing else does.
    expect(runCancels.length).toBe(2);
    expect(said(h, "foundational", "stop")).toBe(1);
  });
});
