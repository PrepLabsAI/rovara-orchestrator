import type { Executor } from "./types.js";

/** github.resolve_thread: resolve a review thread Rovara fixed or answered (FR-045). Resolving a resolved thread is a no-op. */
export const githubReview: Executor = async (intent, deps) => {
  const threadId = String(intent.payload.threadId);
  await deps.github.resolveThread(threadId);
  return { resolved: threadId };
};
