import type { Executor } from "./types.js";

/** github.comment: ask the review tool to review again (FR-046). One intent per head commit, by its key. */
export const githubComment: Executor = async (intent, deps) => {
  const p = intent.payload as { repo: string; number: number; body: string };
  await deps.github.comment(p.repo, p.number, p.body);
  return { commented: p.number };
};
