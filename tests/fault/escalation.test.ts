import { afterEach, describe, expect, test } from "vitest";
import { createHarness, SOME_FAULTS, type Harness, type HarnessOptions } from "@rovara-orch/testkit";

let open: Harness[] = [];
afterEach(async () => {
  await Promise.all(open.map((h) => h.drop()));
  open = [];
});

// US1 always fails its checks; US1-docs needs it; US2 does not.
const NODES = [
  { nodeId: "foundational", kind: "foundational", files: ["src/db.ts"] },
  { nodeId: "US1", dependsOn: ["foundational"], files: ["src/signup.ts"] },
  { nodeId: "US1-docs", dependsOn: ["US1"], files: ["docs/signup.md"] },
  { nodeId: "US2", dependsOn: ["foundational"], files: ["src/login.ts"] },
];
const ALWAYS_FAILING = { checks: Array(30).fill("failed") as Array<"failed"> };

describe("a node that keeps failing escalates without stopping unrelated work (SC-006)", () => {
  test.each([
    ["clean", { seed: 12 }],
    ["with faults and crashes", { seed: 13, faults: SOME_FAULTS, crash: { ingress: 0.1, consume: 0.1, intent: 0.1 } }],
  ] as const)("fix requests, then new attempts, then escalation; an operator retry after a fix completes the run (%s)", async (_name, opts: HarnessOptions) => {
    const h = await createHarness({ name: "escalation", ...opts, behaviours: { US1: ALWAYS_FAILING } });
    open.push(h);
    const runId = await h.startRun(await h.seedDag(NODES), { concurrency: 3, retry: { fixRequests: 2, attempts: 3 } });
    const node = async (id: string) => (await h.repos.getRunNode(runId, id))!;

    const escalationPosted = () => h.slack.posts.some((p) => p.text.includes("US1 escalated"));
    expect(await h.runUntil(async () => (await node("US2")).state === "merged" && escalationPosted(), { maxSteps: 4000, maxIdle: 60 })).toBe(true);
    expect((await node("US1")).state).toBe("escalated");

    // Each of the 3 attempts was its own conversation, with 2 fix requests in it.
    const conversations = h.rovara.attemptsFor("US1");
    expect(conversations).toHaveLength(3);
    for (const c of conversations) {
      expect(c.received.filter((r) => r.kind === "message" && /checks failed/i.test(r.text))).toHaveLength(2);
    }
    // The two abandoned attempts' workspaces were closed; the last stays for a person to look at.
    const closes = conversations.map((c) => c.received.filter((r) => r.text === "close this workspace").length);
    expect(closes).toEqual([1, 1, 0]);
    // One Slack message for the escalation, linking the node.
    const posts = h.slack.posts.filter((p) => p.text.includes("US1 escalated"));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toContain(`/runs/${runId}/nodes/US1`);
    // The dependent waits; the unrelated node merged.
    expect((await node("US1-docs")).state).toBe("waiting");
    expect((await node("US2")).state).toBe("merged");

    // The script is fixed and an operator retries.
    h.rovara.setBehaviour("US1", {});
    await h.nodeAction(runId, "US1", "retry", "fixed the failing test");
    expect(await h.runToEnd(runId, { maxSteps: 4000, maxIdle: 60 })).toBe(true);

    const run = (await h.repos.getRun(runId))!;
    expect(run.state).toBe("complete");
    expect((await h.repos.getRunNodes(runId)).every((n) => n.state === "merged")).toBe(true);
    expect(h.rovara.attemptsFor("US1")).toHaveLength(4);
    expect(conversations[2]!.received.filter((r) => r.text === "close this workspace")).toHaveLength(1);
    expect(h.slack.replies.filter((r) => r.threadTs === posts[0]!.ts && /Retried by dev_op: fixed the failing test/.test(r.text))).toHaveLength(1);
    const decisions = await h.repos.listDecisions(runId);
    expect(decisions.filter((d) => d.action === "escalate")).toHaveLength(1);
    expect(decisions.filter((d) => d.action === "retry" && d.actor === "dev_op").length).toBeGreaterThanOrEqual(1);
  });
});
