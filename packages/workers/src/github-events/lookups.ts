import type { ReviewThreadInput } from "@rovara-orch/core";
import type { Deps, ReviewThreadInfo } from "../ports.js";

/** The attempt that owns a PR, from the link the attempt wrote when Rovara reported it. */
export async function attemptForPr(deps: Deps, repo: string, number: number): Promise<string | undefined> {
  return (await deps.table.get<{ attemptId: string }>({ pk: `PRLINK#${repo}#${number}`, sk: "META" }))?.attemptId;
}

/** The PR (and its attempt) whose head is this commit. */
export async function prForHead(deps: Deps, repo: string, sha: string): Promise<{ attemptId: string; number: number } | undefined> {
  return deps.table.get<{ attemptId: string; number: number }>({ pk: `PRHEAD#${repo}#${sha}`, sk: "META" });
}

export const repoOf = (payload: Record<string, unknown>): string => String((payload.repository as { full_name?: string } | undefined)?.full_name ?? "");

/**
 * A thread is "answered" when anyone other than the review tool replied, and "fixed" when it was
 * left on an older commit than the PR's head (Rovara pushed after it). Otherwise it is still open.
 */
export function toThreadInput(t: ReviewThreadInfo, headSha: string): ReviewThreadInput {
  const answered = t.replies.some((r) => r.author !== t.author);
  const fixed = !answered && t.commit !== null && t.commit !== headSha;
  return {
    threadId: t.threadId,
    author: t.author,
    body: t.body,
    path: t.path,
    line: t.line,
    commit: t.commit,
    url: t.url,
    resolved: t.resolved,
    addressed: answered ? "answered" : fixed ? "fixed" : null,
  };
}

/** The review state of a PR's head: whether the review tool reviewed it, and its threads. */
export async function reviewState(deps: Deps, repo: string, number: number, headSha: string) {
  const login = (await deps.repos.getSettings()).reviewToolLogin;
  const [reviewed, threads] = await Promise.all([
    deps.github.hasReviewed(repo, number, headSha, login),
    deps.github.listReviewThreads(repo, number, login),
  ]);
  return { type: "review_state" as const, number, headSha, reviewed, threads: threads.map((t) => toThreadInput(t, headSha)) };
}
