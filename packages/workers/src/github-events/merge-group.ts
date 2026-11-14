import { attemptForPr, repoOf } from "./lookups.js";
import type { GithubEventHandler } from "./types.js";

/** The PR a merge group is for: `refs/heads/gh-readonly-queue/main/pr-<number>-<sha>`. */
export function prOfMergeGroup(headRef: string): number | null {
  const m = /\/pr-(\d+)-[0-9a-f]+$/.exec(headRef);
  return m ? Number(m[1]) : null;
}

/** merge_group: checks requested (entered the queue) and destroyed (removed, unless merged). */
export const mergeGroup: GithubEventHandler = async (deps, payload, deliveryId) => {
  const mg = payload.merge_group as { head_ref?: string } | undefined;
  const number = mg?.head_ref ? prOfMergeGroup(mg.head_ref) : null;
  if (number === null) return [];
  const attemptId = await attemptForPr(deps, repoOf(payload), number);
  if (!attemptId) return [];
  const action = String(payload.action);
  if (action === "checks_requested") {
    return [{ group: `att:${attemptId}`, input: { kind: "github", deliveryId, event: { type: "merge_group", number, status: "entered", reason: null } } }];
  }
  if (action === "destroyed" && payload.reason !== "merged") {
    const reason = payload.reason === "invalidated" ? "out_of_date" : "other";
    return [{ group: `att:${attemptId}`, input: { kind: "github", deliveryId, event: { type: "merge_group", number, status: "removed", reason } } }];
  }
  return [];
};
