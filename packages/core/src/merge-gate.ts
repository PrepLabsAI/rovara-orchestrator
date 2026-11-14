import type { Attempt, Repository, Settings } from "./model.js";

export const MERGE_CONDITIONS = [
  "not_current_pr",
  "wrong_repo",
  "base_not_main",
  "checks_not_passed",
  "no_changes",
  "not_reviewed",
  "unresolved_comments",
  "ci_failing_pr",
  "ci_failing_queue",
  "repo_paused",
  "stop_switch",
] as const;
export type MergeCondition = (typeof MERGE_CONDITIONS)[number];

export interface MergeInputs {
  attempt: Attempt;
  /** The PR the caller wants to merge. */
  prNumber: number;
  /** The monorepo the DAG belongs to. */
  dagRepo: string;
  repo: Repository;
  settings: Settings;
}

/**
 * FR-040: the only judgement of whether a pull request may be merged. Every condition must hold:
 * it is the PR Rovara reported for the current attempt, on the monorepo, targeting main; Rovara's
 * check report is `passed`; it has changes; the review tool reviewed its latest commit with nothing
 * unresolved; required CI passes on the PR (and has not failed in the queue); main is healthy; the
 * stop switch is off.
 */
export function canMerge(i: MergeInputs): { ok: boolean; failing: MergeCondition[] } {
  const failing: MergeCondition[] = [];
  const a = i.attempt;
  const pr = a.pullRequests.at(-1);
  if (!pr || pr.number !== i.prNumber || pr.state !== "open") failing.push("not_current_pr");
  if (pr && pr.repo !== null && pr.repo !== i.dagRepo) failing.push("wrong_repo");
  if (pr && pr.baseRef !== null && pr.baseRef !== "main") failing.push("base_not_main");
  if (a.checkReports.at(-1)?.status !== "passed") failing.push("checks_not_passed");
  if (!pr || pr.changedFiles === null || pr.changedFiles <= 0) failing.push("no_changes");
  if (!pr?.headSha || a.review.headSha !== pr.headSha || !a.review.reviewedAt) failing.push("not_reviewed");
  if (a.review.unresolved > 0) failing.push("unresolved_comments");
  if (!pr?.headSha || a.ci.headSha !== pr.headSha || a.ci.pr !== "passed") failing.push("ci_failing_pr");
  if (a.ci.queue === "failed") failing.push("ci_failing_queue");
  if (i.repo.paused) failing.push("repo_paused");
  if (i.settings.stopSwitch.on) failing.push("stop_switch");
  return { ok: failing.length === 0, failing };
}
