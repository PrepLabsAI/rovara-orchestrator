import type { AttemptHandler, RunHandler } from "../types.js";

/** Attempt-level capacity (workspace-limit refusals). Stub until US6. */
export const capacity: AttemptHandler = () => undefined;

/** Run-level capacity (run-start workspace-limit check). Stub until US6. */
export const runCapacity: RunHandler = () => undefined;
