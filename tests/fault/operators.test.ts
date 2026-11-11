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

describe("runs pause for their operator and their budget (FR-052, FR-057)", () => {
  test.each([
    ["clean", { seed: 31 }],
    ["with faults and crashes", { seed: 32, faults: SOME_FAULTS, crash: { ingress: 0.1, consume: 0.1, intent: 0.1 } }],
  ] as const)("the operator loses Rovara access mid-run: the run pauses, a take-over resumes it, nothing is lost or sent twice (%s)", async (_name, opts: HarnessOptions) => {
    const h = await createHarness({ name: "access", ...opts });
    open.push(h);
    const runId = await h.startRun(await h.seedDag(NODES), { concurrency: 3, operator: "dev_alice" });
    expect(await h.runUntil(async () => (await h.repos.getRunNode(runId, "foundational"))!.state === "merged")).toBe(true);

    h.rovara.unlink("dev_alice");
    expect(await h.runUntil(async () => (await h.repos.getRun(runId))?.pausedFor === "lost_access" && h.slack.posts.some((p) => p.text.includes("no longer accepts work for dev_alice")))).toBe(true);

    await h.controlRun(runId, "take_over", "Alice lost access", undefined, "dev_bob");
    expect(await h.runToEnd(runId, { maxSteps: 4000, maxIdle: 60 })).toBe(true);

    const run = (await h.repos.getRun(runId))!;
    expect(run).toMatchObject({ state: "complete", actingFor: "dev_bob" });
    for (const id of ["US1", "US2"]) {
      const received = h.rovara.attemptsFor(id).flatMap((c) => c.received);
      expect(received.filter((r) => r.kind === "decision"), `${id} plan approved once`).toHaveLength(1);
      expect(received.filter((r) => r.text === "Checks passed. Create the pull request."), `${id} asked for its PR once`).toHaveLength(1);
    }
    expect(h.github.merges).toHaveLength(3);
    expect(h.slack.replies.filter((r) => r.text === "Taken over by dev_bob.")).toHaveLength(1);
  });

  test("reaching the cost limit pauses the run with a Slack message; an operator's resume replies in the thread", async () => {
    const h = await createHarness({ name: "cost", seed: 33, behaviours: { US1: { questions: [{ text: "24h or 7d?", choices: ["24h", "7d"] }] } } });
    open.push(h);
    const runId = await h.startRun(await h.seedDag(NODES), { concurrency: 3, costLimitUsd: 0.01 });
    expect(await h.runUntil(async () => (await h.repos.getRun(runId))?.pausedFor === "cost" && h.slack.posts.some((p) => p.text.includes("reached its cost limit")))).toBe(true);
    expect(h.slack.posts.filter((p) => p.text.includes("reached its cost limit"))).toHaveLength(1);
    await h.controlRun(runId, "resume", "accepting the extra cost");
    expect(await h.runToEnd(runId, { maxSteps: 4000, maxIdle: 60 })).toBe(true);
    expect(h.slack.replies.filter((r) => r.text === "Resumed by dev_op.")).toHaveLength(1);
  });
});
