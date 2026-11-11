import { reviewRound } from "../../text/brief.js";
import { currentPr, Draft, escalate, reviewDue, tryEnqueue } from "../steps.js";
import type { AttemptHandler, ReviewThreadInput } from "../types.js";

const rcKey = (attemptId: string, number: number, threadId: string) => ({ pk: `ATT#${attemptId}`, sk: `RC#${number}#${threadId}` });

/**
 * The review loop (FR-045, FR-046): unresolved review-tool comments on the latest commit go to
 * Rovara as review rounds; threads Rovara fixed or answered are resolved; a PR is queued only once
 * its latest commit is reviewed with nothing unresolved. No review in 30 minutes: ask once more;
 * none 30 minutes later: escalate.
 */
export const review: AttemptHandler = (ctx, input) => {
  const pr = currentPr(ctx.attempt);
  if (!pr) return undefined;

  if (input.kind === "timer" && input.timer === "review") {
    if (ctx.attempt.phase === "queued" || ctx.attempt.phase === "merged") return undefined;
    if (ctx.attempt.review.reviewedAt && ctx.attempt.review.headSha === pr.headSha) return undefined;
    const d = new Draft(ctx);
    if (!ctx.attempt.review.rerequestedAt) {
      d.intent("github.comment", `rereview:${pr.number}:${pr.headSha ?? "none"}`, { repo: ctx.dag.repo, number: pr.number, body: ctx.settings.reRequestComment });
      d.attempt.review.rerequestedAt = ctx.now;
      d.attempt.due.reviewAt = reviewDue(ctx.now);
      return d.done();
    }
    escalate(d, "the review tool did not review the latest commit, even after asking again");
    return d.done();
  }

  if (input.kind !== "github" || input.event.type !== "review_state") return undefined;
  const e = input.event;
  if (e.number !== pr.number || (pr.headSha && e.headSha !== pr.headSha)) return undefined;
  if (ctx.attempt.phase === "queued" || ctx.attempt.phase === "merged") return undefined;

  const d = new Draft(ctx);
  const a = d.attempt;
  const toResolve = e.threads.filter((t) => !t.resolved && t.addressed);
  const open = e.threads.filter((t) => !t.resolved && !t.addressed);
  for (const t of e.threads) {
    const resolution = t.resolved ? "resolved_by_tool" : t.addressed;
    if (resolution) d.records.push(record(a.attemptId, pr.number, t, null, resolution));
  }
  for (const t of toResolve) d.intent("github.resolve_thread", `resolve:${t.threadId}`, { threadId: t.threadId });

  if (e.reviewed) {
    a.review.reviewedAt = ctx.now;
    a.review.headSha = e.headSha;
    a.due.reviewAt = null;
  }
  a.review.unresolved = toResolve.length + open.length;

  const unsent = open.filter((t) => !a.review.sent.includes(t.threadId));
  if (unsent.length) {
    if (d.node.reviewRounds >= ctx.run.retry.reviewRounds) {
      escalate(d, `out of review rounds (${ctx.run.retry.reviewRounds}) with ${open.length} comment(s) unresolved`);
      return d.done();
    }
    const round = d.node.reviewRounds + 1;
    d.node = { ...d.node, reviewRounds: round };
    a.review.sent = [...a.review.sent, ...unsent.map((t) => t.threadId)];
    a.phase = "reviewing";
    for (const t of unsent) d.records.push(record(a.attemptId, pr.number, t, round, null));
    d.intent("rovara.message", `${a.attemptId}.review.${round}`, { text: reviewRound(unsent) });
    return d.done();
  }

  if (a.review.unresolved === 0 && a.phase === "reviewing") a.phase = "pr_open";
  tryEnqueue(d);
  return d.done();
};

function record(attemptId: string, number: number, t: ReviewThreadInput, round: number | null, resolution: string | null) {
  return {
    kind: "update" as const,
    key: rcKey(attemptId, number, t.threadId),
    attrs: {
      entityType: "REVIEW_COMMENT",
      attemptId,
      prNumber: number,
      threadId: t.threadId,
      author: t.author,
      body: t.body,
      path: t.path,
      line: t.line,
      commit: t.commit,
      url: t.url,
      ...(round !== null ? { round } : {}),
      ...(resolution !== null ? { resolution } : {}),
    },
  };
}
