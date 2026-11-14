import { afterEach, describe, expect, test } from "vitest";
import { createHarness, SOME_FAULTS, type Harness, type HarnessOptions } from "@rovara-orch/testkit";

let open: Harness[] = [];
afterEach(async () => {
  await Promise.all(open.map((h) => h.drop()));
  open = [];
});

describe("Rovara's workspace limit (FR-062)", () => {
  test.each([
    ["clean", { seed: 51 }],
    ["with faults and crashes", { seed: 52, faults: SOME_FAULTS, crash: { ingress: 0.1, consume: 0.1, intent: 0.1 } }],
  ] as const)("refused starts send the node back to waiting, use no attempt, and the run still completes (%s)", async (_name, opts: HarnessOptions) => {
    // US1 is refused 3 times, more than its 2 attempts: refusals must not count.
    const h = await createHarness({ name: "capacity", ...opts, behaviours: { US1: { workspaceLimits: 3 } } });
    open.push(h);
    const runId = await h.startRun(await h.seedDag([{ nodeId: "US1", files: ["src/a.ts"] }, { nodeId: "US2", files: ["src/b.ts"] }]), { concurrency: 2, retry: { attempts: 2 } });
    expect(await h.runToEnd(runId, { maxSteps: 4000, maxIdle: 60 })).toBe(true);
    const us1 = (await h.repos.getRunNode(runId, "US1"))!;
    expect(us1).toMatchObject({ state: "merged", refusedStarts: 3, attempts: 4 });
    const decisions = await h.repos.listDecisions(runId);
    expect(decisions.filter((d) => d.action === "escalate" || d.action === "retry")).toHaveLength(0);
    expect(h.github.merges).toHaveLength(2);
  });
});
