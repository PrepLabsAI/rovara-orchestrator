import { capacity } from "./handlers/capacity.js";
import { conflicts } from "./handlers/conflicts.js";
import { controls, latePrAfterCancel, nodeActions } from "./handlers/controls.js";
import { failures } from "./handlers/failures.js";
import { happyPath } from "./handlers/happy-path.js";
import { review } from "./handlers/review.js";
import { FINAL_ATTEMPT_PHASES } from "../model.js";
import type { AttemptContext, AttemptHandler, AttemptInput, AttemptTransition } from "./types.js";

/** Fixed order: the first handler that returns a transition wins. */
export const ATTEMPT_HANDLERS: ReadonlyArray<[string, AttemptHandler]> = [
  ["happy-path", happyPath],
  ["review", review],
  ["failures", failures],
  ["conflicts", conflicts],
  ["controls", controls],
  ["capacity", capacity],
];

/**
 * Inputs for an attempt that is not its node's current one, or that has ended, change nothing; they
 * are stored by the ingress but not acted on (FR-025). The one exception: a merge that reached main
 * after a cancel still counts, because the code is merged (spec: never both).
 */
function stale(ctx: AttemptContext, input: AttemptInput): boolean {
  const lateMerge = input.kind === "github" && input.event.type === "merged_on_main";
  if (lateMerge) return ctx.node.state === "merged";
  if (ctx.node.currentAttempt !== ctx.attempt.attemptId) return true;
  return FINAL_ATTEMPT_PHASES.includes(ctx.attempt.phase);
}

/** The attempt machine (queue group `att:<attemptId>`). */
export function attemptMachine(ctx: AttemptContext, input: AttemptInput): AttemptTransition | undefined {
  // An escalated node's attempt has ended; only the operator's choice moves it on (FR-033).
  if (input.kind === "node_action") return nodeActions(ctx, input);
  const late = ctx.node.currentAttempt === ctx.attempt.attemptId ? latePrAfterCancel(ctx, input) : undefined;
  if (late) return late;
  if (stale(ctx, input)) return undefined;
  for (const [, handler] of ATTEMPT_HANDLERS) {
    const t = handler(ctx, input);
    if (t) return t;
  }
  return undefined;
}
