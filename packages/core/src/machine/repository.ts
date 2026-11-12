import { repoHealth } from "../repo-health.js";
import { repoCapacity } from "./handlers/capacity.js";
import type { RepoContext, RepoHandler, RepoInput, RepoTransition } from "./types.js";

export const REPO_HANDLERS: ReadonlyArray<[string, RepoHandler]> = [
  ["health", repoHealth],
  ["capacity", repoCapacity],
];

/** The repository machine (queue group `repo:<owner/name>`): main health, capacity and back-off. */
export function repositoryMachine(ctx: RepoContext, input: RepoInput): RepoTransition | undefined {
  for (const [, handler] of REPO_HANDLERS) {
    const t = handler(ctx, input);
    if (t) return t;
  }
  return undefined;
}
