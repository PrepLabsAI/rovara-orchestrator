import type { Executor } from "./types.js";

/** github.close_pr: close an unmerged PR when its run is cancelled (FR-050). Closing a closed PR is a no-op. */
export const githubPr: Executor = async (intent, deps) => {
  const p = intent.payload as { repo: string; number: number };
  await deps.github.closePull(p.repo, p.number);
  return { closed: p.number };
};
