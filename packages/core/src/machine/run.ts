import { runCapacity } from "./handlers/capacity.js";
import { runControls } from "./handlers/controls.js";
import type { RunContext, RunHandler, RunInput, RunTransition } from "./types.js";

export const RUN_HANDLERS: ReadonlyArray<[string, RunHandler]> = [
  ["controls", runControls],
  ["capacity", runCapacity],
];

/** The run machine (queue group `run:<runId>`). It never writes an attempt; it enqueues inputs for them. */
export function runMachine(ctx: RunContext, input: RunInput): RunTransition | undefined {
  for (const [, handler] of RUN_HANDLERS) {
    const t = handler(ctx, input);
    if (t) return t;
  }
  return undefined;
}
