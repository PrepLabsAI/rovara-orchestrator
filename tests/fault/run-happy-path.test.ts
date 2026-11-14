import { afterEach, describe, expect, test } from "vitest";
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
];

async function run(opts: HarnessOptions) {
  const h = await createHarness({ name: "happy", ...opts });
  open.push(h);
  const dagId = await h.seedDag(NODES);
  const runId = await h.startRun(dagId, { concurrency: 3 });
  const finished = await h.runToEnd(runId, { maxSteps: 4000, maxIdle: 60 });
  return { h, runId, finished };
}

/** The exactly-once properties of a finished run (SC-002, SC-004). */
async function expectExactlyOnce(h: Harness, runId: string) {
  const run = await h.repos.getRun(runId);
  expect(run?.state).toBe("complete");
  const nodes = await h.repos.getRunNodes(runId);
  expect(nodes.every((n) => n.state === "merged")).toBe(true);
  expect(run?.counts.merged).toBe(3);

  for (const n of NODES) {
    // one conversation per attempt, and one attempt per node in a clean run
    expect(h.rovara.attemptsFor(n.nodeId), `${n.nodeId} conversations`).toHaveLength(1);
    const conv = h.rovara.attemptsFor(n.nodeId)[0]!;
    expect(conv.received.filter((r) => r.kind === "decision"), `${n.nodeId} plan approvals`).toHaveLength(1);
    expect([...h.github.pulls.values()].filter((p) => p.headRef.includes(`.${n.nodeId}.`)), `${n.nodeId} PRs`).toHaveLength(1);
  }
  expect(h.github.merges, "one merge per node").toHaveLength(3);

  // Dependency order: each child's base commit is at or after its parent's merge commit.
  const mainIndex = (sha: string | null) => h.github.main.findIndex((c) => c.sha === sha);
  const merged = new Map(nodes.map((n) => [n.nodeId, mainIndex(n.mergeCommit)]));
  for (const n of nodes) {
    const attempt = await h.repos.getAttempt(n.currentAttempt!);
    for (const dep of NODES.find((x) => x.nodeId === n.nodeId)?.dependsOn ?? []) {
      expect(mainIndex(attempt!.baseCommit), `${n.nodeId} starts after ${dep} merged`).toBeGreaterThanOrEqual(merged.get(dep)!);
    }
  }

  // One decision record per automatic action.
  const decisions = await h.repos.listDecisions(runId);
  const count = (action: string) => decisions.filter((d) => d.action === action && d.actor === "orchestrator").length;
  expect(count("approve")).toBe(3);
  expect(count("merge")).toBe(3);
}

describe("a 3-node DAG runs to completion with no person involved", () => {
  test("clean run: merges in dependency order, exactly once each", async () => {
    const { h, runId, finished } = await run({ seed: 1 });
    expect(finished).toBe(true);
    await expectExactlyOnce(h, runId);
    expect(h.github.merges[0]!.number).toBe([...h.github.pulls.values()].find((p) => p.headRef.includes(".foundational."))!.number);
  });

  test("the stop switch holds every start, plan approval and merge until it is turned off (FR-051)", async () => {
    const h = await createHarness({ name: "stop", seed: 5 });
    open.push(h);
    const dagId = await h.seedDag(NODES);
    const runId = await h.startRun(dagId, { concurrency: 3 });
    const node = async (id: string) => (await h.repos.getRunNodes(runId)).find((n) => n.nodeId === id)!;
    const conversations = () => NODES.reduce((n, x) => n + h.rovara.attemptsFor(x.nodeId).length, 0);
    /** Ten quiet minutes with the switch on: nothing may move. */
    const holdFor = async (expectSame: () => unknown) => {
      await h.setStopSwitch(true, "hold");
      const before = JSON.stringify(expectSame());
      for (let minute = 0; minute < 10; minute++) {
        await h.idle();
        for (let s = 0; s < 20 && (await h.step()); s++);
      }
      expect(JSON.stringify(expectSame())).toBe(before);
      await h.setStopSwitch(false, "go");
    };

    // 1. A plan approval asked for while on is held.
    expect(await h.runUntil(async () => h.rovara.attemptsFor("foundational").length === 1)).toBe(true);
    await holdFor(() => h.rovara.attemptsFor("foundational")[0]!.received.filter((r) => r.kind === "decision").length);
    // 2. A PR that is ready to merge while on is not queued.
    expect(await h.runUntil(async () => (await node("foundational")).state === "pr_open")).toBe(true);
    await holdFor(() => h.github.merges.length);
    // 3. Nodes unblocked while on are not started.
    expect(await h.runUntil(async () => (await node("foundational")).state === "merged")).toBe(true);
    await holdFor(conversations);

    expect(await h.runToEnd(runId, { maxSteps: 4000, maxIdle: 60 })).toBe(true);
    await expectExactlyOnce(h, runId);
  });

  test.each([11, 22, 33])("with duplicated, delayed, dropped and reordered deliveries and crashes at every boundary (seed %i)", async (seed) => {
    const { h, runId, finished } = await run({ seed, faults: SOME_FAULTS, crash: { ingress: 0.1, consume: 0.1, intent: 0.1 } });
    expect(finished).toBe(true);
    await expectExactlyOnce(h, runId);
    const counts = h.faultCounts();
    for (const kind of ["duplicate", "delay", "drop", "reorder", "restart"] as const) {
      expect(counts[kind], `${kind} faults were injected`).toBeGreaterThan(0);
    }
  });
});
