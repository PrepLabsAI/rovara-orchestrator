import type { WorkMessage } from "@rovara-orch/core";
import { prForHead, repoOf } from "./lookups.js";
import type { GithubEventHandler } from "./types.js";

/** The head commit a check event is about. */
function shaOf(payload: Record<string, unknown>): string | undefined {
  if (payload.check_suite) return (payload.check_suite as { head_sha?: string }).head_sha;
  if (payload.check_run) return (payload.check_run as { head_sha?: string }).head_sha;
  return payload.sha as string | undefined;
}

/**
 * check_suite, check_run and status on a PR head. One suite finishing says little about the rest,
 * so the input carries the commit's combined required-check status, read from GitHub.
 */
export const checks: GithubEventHandler = async (deps, payload, deliveryId) => {
  const repo = repoOf(payload);
  const sha = shaOf(payload);
  if (!sha) return [];
  const owner = await prForHead(deps, repo, sha);
  if (!owner) return [];
  const { status, failing } = await deps.github.checksForSha(repo, sha);
  const m: WorkMessage = {
    group: `att:${owner.attemptId}`,
    input: { kind: "github", deliveryId, event: { type: "checks", number: owner.number, headSha: sha, scope: "pr", status, failing } },
  };
  return [m];
};
