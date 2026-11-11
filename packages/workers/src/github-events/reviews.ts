import { attemptForPr, repoOf, reviewState } from "./lookups.js";
import type { GithubEventHandler } from "./types.js";

/** pull_request_review, pull_request_review_comment and pull_request_review_thread: the review state of the PR's head. */
export const reviews: GithubEventHandler = async (deps, payload, deliveryId) => {
  const pr = payload.pull_request as { number: number; head: { sha: string } } | undefined;
  if (!pr) return [];
  const repo = repoOf(payload);
  const attemptId = await attemptForPr(deps, repo, pr.number);
  if (!attemptId) return [];
  const event = await reviewState(deps, repo, pr.number, pr.head.sha);
  return [{ group: `att:${attemptId}`, input: { kind: "github", deliveryId, event } }];
};
