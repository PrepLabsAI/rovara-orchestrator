import type { GithubAttemptEvent, WorkMessage } from "@rovara-orch/core";
import { attemptForPr, repoOf } from "./lookups.js";
import type { GithubEventHandler } from "./types.js";

const DEQUEUE_REASON: Record<string, "conflict" | "out_of_date" | "failed_checks" | "other"> = {
  MERGE_CONFLICT: "conflict",
  BRANCH_PROTECTIONS: "out_of_date",
  CI_FAILURE: "failed_checks",
  CI_TIMEOUT: "failed_checks",
};

type PrPayload = {
  number: number;
  node_id: string;
  head: { sha: string };
  base: { ref: string; repo?: { full_name: string } };
  merged?: boolean;
  merge_commit_sha?: string | null;
  changed_files?: number;
};

/** pull_request: opened, synchronize, closed (merged or not), enqueued and dequeued. */
export const pullRequests: GithubEventHandler = async (deps, payload, deliveryId) => {
  const pr = payload.pull_request as PrPayload | undefined;
  if (!pr) return [];
  const repo = repoOf(payload);
  const number = Number(payload.number ?? pr.number);
  const attemptId = await attemptForPr(deps, repo, number);
  if (!attemptId) return [];
  const action = String(payload.action);
  let event: GithubAttemptEvent | undefined;
  if (action === "opened" || action === "reopened" || action === "synchronize" || action === "edited") {
    event = {
      type: action === "synchronize" ? "pr_synchronize" : "pr_opened",
      number,
      headSha: pr.head.sha,
      baseRef: pr.base.ref,
      repo: pr.base.repo?.full_name ?? repo,
      changedFiles: pr.changed_files ?? 0,
    };
  } else if (action === "closed") {
    if (pr.merged && pr.merge_commit_sha) {
      // FR-043: merged counts only once the merge commit is on main.
      event = (await deps.github.isReachableFromMain(repo, pr.merge_commit_sha))
        ? { type: "merged_on_main", number, mergeCommit: pr.merge_commit_sha }
        : { type: "pr_closed", number, merged: true, mergeCommit: pr.merge_commit_sha };
    } else {
      event = { type: "pr_closed", number, merged: false, mergeCommit: null };
    }
  } else if (action === "enqueued") {
    event = { type: "merge_group", number, status: "entered", reason: null };
  } else if (action === "dequeued") {
    event = { type: "merge_group", number, status: "removed", reason: DEQUEUE_REASON[String(payload.reason)] ?? "other" };
  }
  if (!event) return [];
  const m: WorkMessage = { group: `att:${attemptId}`, input: { kind: "github", deliveryId, event } };
  return [m];
};
