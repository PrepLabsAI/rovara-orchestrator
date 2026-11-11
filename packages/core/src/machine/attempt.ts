import { capacity } from "./handlers/capacity.js";
import { conflicts } from "./handlers/conflicts.js";
import { controls } from "./handlers/controls.js";
import { failures } from "./handlers/failures.js";
import { happyPath } from "./handlers/happy-path.js";
import { review } from "./handlers/review.js";
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

/** The attempt machine (queue group `att:<attemptId>`). */
export function attemptMachine(ctx: AttemptContext, input: AttemptInput): AttemptTransition | undefined {
  for (const [, handler] of ATTEMPT_HANDLERS) {
    const t = handler(ctx, input);
    if (t) return t;
  }
  return undefined;
}
