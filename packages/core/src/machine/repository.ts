import { repoHealth } from "../repo-health.js";
import type { RepoContext, RepoInput, RepoTransition } from "./types.js";

/** The repository machine (queue group `repo:<owner/name>`): main health. */
export function repositoryMachine(ctx: RepoContext, input: RepoInput): RepoTransition | undefined {
  return repoHealth(ctx, input);
}
