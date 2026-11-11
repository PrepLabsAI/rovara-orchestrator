import { repoOf } from "./lookups.js";
import type { GithubEventHandler } from "./types.js";

/**
 * Check suites, check runs and statuses on main. One payload names one check; whether main is red
 * is a property of all its required checks on its current head, so the mapper reads that afresh
 * and sends a confirmed result (constitution III: read the record rather than guess).
 */
export const mainChecks: GithubEventHandler = async (deps, payload) => {
  const repo = repoOf(payload);
  const { headSha, status, failing } = await deps.github.requiredChecksOnMain(repo);
  return [{ group: `repo:${repo}`, input: { kind: "main_checks", headSha, status, failing, confirmed: true } }];
};
