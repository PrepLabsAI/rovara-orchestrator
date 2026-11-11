import { traceStepOps } from "@rovara-orch/store";
import type { RovaraEventHook } from "../rovara-event-hooks.js";

/** Conversation-level events kept as trace steps until Rovara streams the agent's own trace (Rovara#441). */
export const TRACE_KINDS = new Set(["progress", "message", "check_report", "pr"]);

/** Store a Rovara event as the attempt's next trace step, in arrival order (FR-055). */
export const traceHook: RovaraEventHook = async (deps, event, attemptId, receivedAt) => {
  if (!TRACE_KINDS.has(event.type)) return [];
  return traceStepOps(deps.table, attemptId, { at: receivedAt, kind: event.type, payload: event.data });
};
