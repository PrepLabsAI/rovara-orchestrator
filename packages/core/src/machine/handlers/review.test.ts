import { describe, expect, test } from "vitest";
import { anAttemptContext } from "../../testing/fixtures.js";
import type { AttemptContext, ReviewThreadInput } from "../types.js";
import { review } from "./review.js";

const head = "h".repeat(40);
const thread = (id: string, p: Partial<ReviewThreadInput> = {}): ReviewThreadInput => ({
  threadId: id,
  author: "coderabbitai[bot]",
  body: `fix ${id}`,
  path: "src/a.ts",
  line: 3,
  commit: head,
  url: `https://github.com/acme/mono/pull/7#${id}`,
  resolved: false,
  addressed: null,
  ...p,
});

function prCtx(p: { reviewRounds?: number; reviewedAt?: string | null; rerequestedAt?: string | null } = {}): AttemptContext {
  const base = anAttemptContext();
  return {
    ...base,
    node: { ...base.node, state: "pr_open", reviewRounds: p.reviewRounds ?? 0 },
    attempt: {
      ...base.attempt,
      phase: "pr_open",
      checkReports: [{ status: "passed", at: "t", text: "ok" }],
      pullRequests: [{ number: 7, url: "u", headSha: head, state: "open", openedAt: "2026-11-11T00:00:00.000Z", changedFiles: 2, baseRef: "main", repo: "acme/mono", mergeCommit: null }],
      review: { headSha: head, reviewedAt: p.reviewedAt ?? null, rerequestedAt: p.rerequestedAt ?? null, unresolved: 0, sent: [] },
      ci: { headSha: head, pr: "passed", queue: "none", failing: [] },
      due: { quietAt: null, reviewAt: "2026-11-11T00:30:00.000Z", retryAt: null },
    },
  };
}
const reviewState = (threads: ReviewThreadInput[], reviewed = true) => ({
  kind: "github" as const,
  deliveryId: `d-${Math.random()}`,
  event: { type: "review_state" as const, number: 7, headSha: head, reviewed, threads },
});

describe("review loop", () => {
  test("unresolved review-tool comments on the latest commit go to Rovara as one review round", () => {
    const t = review(prCtx(), reviewState([thread("T1"), thread("T2")]))!;
    const msgs = t.intents.filter((i) => i.effect === "rovara.message");
    expect(msgs).toHaveLength(1);
    expect(String(msgs[0]!.payload.text)).toContain("#T1");
    expect(String(msgs[0]!.payload.text)).toContain("#T2");
    expect(t.node?.reviewRounds).toBe(1);
    expect(t.attempt?.phase).toBe("reviewing");
    expect(t.attempt?.review.unresolved).toBe(2);
    expect((t.records ?? []).filter((r) => r.kind !== "delete" && r.key.sk.startsWith("RC#"))).toHaveLength(2);
    expect(t.intents.map((i) => i.effect)).not.toContain("github.enqueue");
  });

  test("a thread Rovara fixed or answered is resolved by the orchestrator; one the tool resolved counts as resolved", () => {
    const t = review(prCtx({ reviewRounds: 1 }), reviewState([thread("T1", { addressed: "fixed" }), thread("T2", { addressed: "answered" }), thread("T3", { resolved: true })]))!;
    expect(t.intents.filter((i) => i.effect === "github.resolve_thread").map((i) => i.payload.threadId)).toEqual(["T1", "T2"]);
    const records = (t.records ?? []).filter((r) => r.kind !== "delete") as unknown as Array<{ attrs: { threadId: string; resolution: string } }>;
    expect(Object.fromEntries(records.map((r) => [r.attrs.threadId, r.attrs.resolution]))).toEqual({ T1: "fixed", T2: "answered", T3: "resolved_by_tool" });
    expect(t.intents.filter((i) => i.effect === "rovara.message")).toHaveLength(0);
  });

  test("with nothing unresolved and the latest commit reviewed, the PR is queued", () => {
    const t = review(prCtx(), reviewState([]))!;
    expect(t.intents.map((i) => i.effect)).toContain("github.enqueue");
    expect(t.node?.state).toBe("in_merge_queue");
  });

  test("out of review rounds with comments left escalates", () => {
    const t = review(prCtx({ reviewRounds: 3 }), reviewState([thread("T9")]))!;
    expect(t.node?.state).toBe("escalated");
    expect(t.intents.map((i) => i.effect)).toContain("slack.post");
    expect(t.decisions.map((d) => d.action)).toContain("escalate");
  });

  test("no review within 30 minutes asks for one more; none 30 minutes later escalates", () => {
    const first = prCtx();
    const t1 = review({ ...first, now: "2026-11-11T00:31:00.000Z" }, { kind: "timer", timer: "review", at: "2026-11-11T00:30:00.000Z" })!;
    expect(t1.intents).toEqual([expect.objectContaining({ effect: "github.comment" })]);
    expect(t1.attempt?.review.rerequestedAt).toBe("2026-11-11T00:31:00.000Z");
    expect(t1.attempt?.due.reviewAt).toBe("2026-11-11T01:01:00.000Z");
    const second = { ...prCtx({ rerequestedAt: "2026-11-11T00:31:00.000Z" }), now: "2026-11-11T01:02:00.000Z" };
    const t2 = review(second, { kind: "timer", timer: "review", at: "2026-11-11T01:01:00.000Z" })!;
    expect(t2.node?.state).toBe("escalated");
  });

  test("a PR is never queued without the review of its latest commit", () => {
    const t = review(prCtx(), reviewState([], false));
    expect((t?.intents ?? []).map((i) => i.effect)).not.toContain("github.enqueue");
  });
});
