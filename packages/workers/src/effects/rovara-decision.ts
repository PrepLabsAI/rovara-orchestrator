import { attemptAndRun, attemptIdOf } from "./actor.js";
import type { Executor } from "./types.js";

/** rovara.decision: approve the plan, echoing the request Rovara sent (FR-023). */
export const rovaraDecision: Executor = async (intent, deps) => {
  const p = intent.payload as { requestId: string; expectedRevision: number; artifactDigest: string; decision: "APPROVE"; reason: string };
  const { attempt, actor } = await attemptAndRun(deps, attemptIdOf(intent.payload));
  await deps.rovara.sendDecision({
    conversation: attempt.conversation,
    actor,
    eventId: intent.key,
    requestId: p.requestId,
    expectedRevision: p.expectedRevision,
    artifactDigest: p.artifactDigest,
    decision: p.decision,
    reason: p.reason,
  });
  return { eventId: intent.key };
};
