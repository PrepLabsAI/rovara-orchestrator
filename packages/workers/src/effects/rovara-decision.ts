import { deliver } from "./actor.js";
import type { Executor } from "./types.js";

/** rovara.decision: approve the plan, echoing the request Rovara sent (FR-023). */
export const rovaraDecision: Executor = (intent, deps) => {
  const p = intent.payload as { requestId: string; expectedRevision: number; artifactDigest: string; decision: "APPROVE"; reason: string };
  return deliver(deps, intent, ({ attempt, actor, eventId }) =>
    deps.rovara.sendDecision({
      conversation: attempt.conversation,
      actor,
      eventId,
      requestId: p.requestId,
      expectedRevision: p.expectedRevision,
      artifactDigest: p.artifactDigest,
      decision: p.decision,
      reason: p.reason,
    }),
  );
};
