import { describe, expect, test } from "vitest";
import type { Attempt, NodeRunState, PullRequestRef } from "../../model.js";
import { anAttemptContext, aRun } from "../../testing/fixtures.js";
import { attemptMachine } from "../attempt.js";
import type { AttemptContext, AttemptInput, AttemptTransition } from "../types.js";

const head = "h".repeat(40);
const pr: PullRequestRef = { number: 7, url: "u", headSha: head, state: "open", openedAt: "t", changedFiles: 1, baseRef: "main", repo: "acme/mono", mergeCommit: null };
function queued(node: Partial<NodeRunState> = {}, attempt: Partial<Attempt> = {}): AttemptContext {
  const base = anAttemptContext({ run: aRun({ retry: { fixRequests: 2, attempts: 3, prUpdates: 2, reviewRounds: 3, quietMinutes: 30 } }) });
  return {
    ...base,
    repo: { ...base.repo, mainCommit: "c".repeat(40) },
    attempt: {
      ...base.attempt,
      phase: "queued",
      checkReports: [{ status: "passed", at: "t", text: "ok" }],
      pullRequests: [pr],
      review: { headSha: head, reviewedAt: "t", rerequestedAt: null, unresolved: 0, sent: [] },
      ci: { headSha: head, pr: "passed", queue: "pending", failing: [] },
      ...attempt,
    },
    node: { ...base.node, state: "in_merge_queue", prUpdates: 0, ...node },
  };
}
const removed = (reason: "conflict" | "out_of_date" | "failed_checks" | "other"): AttemptInput => ({ kind: "github", deliveryId: `d-${reason}`, event: { type: "merge_group", number: 7, status: "removed", reason } });
const apply = (ctx: AttemptContext, t: AttemptTransition): AttemptContext => ({ ...ctx, attempt: t.attempt ?? ctx.attempt, node: t.node ?? ctx.node });

describe("conflicts and out-of-date PRs (FR-042)", () => {
  test.each(["conflict", "out_of_date"] as const)("leaving the queue with %s gets an update request while PR updates remain", (reason) => {
    const t = attemptMachine(queued(), removed(reason))!;
    expect(t.intents.map((i) => i.effect)).toEqual(["rovara.message"]);
    expect(String(t.intents[0]!.payload.text)).toMatch(/update the pull request from main/i);
    expect(String(t.intents[0]!.payload.text)).toContain("c".repeat(40));
    expect(t.node).toMatchObject({ state: "pr_open", prUpdates: 1 });
    expect(t.attempt).toMatchObject({ phase: "pr_open", ci: { queue: "none" } });
  });

  test("a conflict found before the queue gets the same update request", () => {
    const ctx = queued({ state: "pr_open" }, { phase: "pr_open", ci: { headSha: head, pr: "passed", queue: "none", failing: [] } });
    const t = attemptMachine(ctx, { kind: "github", deliveryId: "d", event: { type: "conflict", number: 7, headSha: head } })!;
    expect(t.node?.prUpdates).toBe(1);
    expect(t.intents.map((i) => i.effect)).toEqual(["rovara.message"]);
  });

  test("the updated head is queued again once its checks and review pass", () => {
    let ctx = apply(queued(), attemptMachine(queued(), removed("conflict"))!);
    const next = "n".repeat(40);
    ctx = apply(ctx, attemptMachine(ctx, { kind: "github", deliveryId: "s", event: { type: "pr_synchronize", number: 7, headSha: next, baseRef: "main", repo: "acme/mono", changedFiles: 1 } })!);
    ctx = apply(ctx, attemptMachine(ctx, { kind: "github", deliveryId: "r", event: { type: "review_state", number: 7, headSha: next, reviewed: true, threads: [] } })!);
    const t = attemptMachine(ctx, { kind: "github", deliveryId: "c", event: { type: "checks", number: 7, headSha: next, scope: "pr", status: "passed", failing: [] } })!;
    const enqueue = t.intents.find((i) => i.effect === "github.enqueue")!;
    expect(enqueue.payload).toMatchObject({ number: 7, headSha: next });
    expect(t.node?.state).toBe("in_merge_queue");
  });

  test("out of PR updates escalates", () => {
    const t = attemptMachine(queued({ prUpdates: 2 }), removed("conflict"))!;
    expect(t.node?.state).toBe("escalated");
    expect(t.intents.map((i) => i.effect)).toEqual(["slack.post"]);
  });

  test("removed because main is red: back to waiting for the merge, no update used", () => {
    const ctx = queued();
    const t = attemptMachine({ ...ctx, repo: { ...ctx.repo, paused: true } }, removed("failed_checks"))!;
    expect(t.intents).toHaveLength(0);
    expect(t.node).toMatchObject({ state: "pr_open", prUpdates: 0 });
    expect(t.attempt?.ci.queue).toBe("none");
  });

  test("failed checks in the queue while main is green: update from main and fix them", () => {
    const t = attemptMachine(queued({}, { ci: { headSha: head, pr: "passed", queue: "pending", failing: ["ci/test"] } }), removed("failed_checks"))!;
    expect(t.node?.prUpdates).toBe(1);
    expect(String(t.intents[0]!.payload.text)).toMatch(/update the pull request from main/i);
  });

  test("a removal for a PR that is not queued changes nothing", () => {
    expect(attemptMachine(queued({ state: "pr_open" }, { phase: "pr_open" }), removed("conflict"))).toBeUndefined();
  });
});
