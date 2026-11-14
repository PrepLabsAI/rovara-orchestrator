import { FINAL_ATTEMPT_PHASES } from "@rovara-orch/core";
import type { Executor } from "./types.js";

/**
 * github.enqueue: add the PR to the merge queue with the head its checks ran on (FR-041). If the
 * attempt ended (a cancel was recorded) after the merge decision but before this ran, nothing is
 * sent: nothing merges after a recorded cancel.
 */
export const githubEnqueue: Executor = async (intent, deps) => {
  const p = intent.payload as { attemptId: string; repo: string; number: number; headSha: string };
  const attempt = await deps.repos.getAttempt(p.attemptId);
  if (attempt && FINAL_ATTEMPT_PHASES.includes(attempt.phase)) return { skipped: `attempt ${attempt.phase}` };
  const pr = await deps.github.getPull(p.repo, p.number);
  if (pr.state === "merged") return { alreadyMerged: true };
  await deps.github.enqueue(p.repo, pr.nodeId, p.headSha);
  return { enqueued: p.number, headSha: p.headSha };
};
