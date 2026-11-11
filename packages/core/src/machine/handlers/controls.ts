import type { AttemptHandler, RunHandler } from "../types.js";

/** Attempt-level controls (being cancelled, release of a held approval). Stub until US2. */
export const controls: AttemptHandler = () => undefined;

/** Run-level controls (pause, resume, cancel, take-over, cost limit, lost access). Stub until US2. */
export const runControls: RunHandler = () => undefined;
