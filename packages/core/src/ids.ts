import { ulid } from "ulid";

export type IdPrefix = "dag" | "run" | "att" | "dec";

/** A prefixed ULID such as `run_01J...`. Sortable by creation time. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}

/** Rovara's allowed characters for a conversation thread (spec 062, FR-001). */
export const THREAD_RE = /^[A-Za-z0-9._:+@=-]{1,128}$/;

/** The conversation thread for attempt `n` of a node in a run: `<runId>.<nodeId>.a<n>`. */
export function attemptThread(runId: string, nodeId: string, n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new Error(`attempt number must be a positive integer, got ${n}`);
  const thread = `${runId}.${nodeId}.a${n}`;
  if (thread.length > 128) throw new Error(`thread id is longer than 128 characters: ${thread.length}`);
  if (!THREAD_RE.test(thread)) throw new Error(`thread id has characters Rovara does not allow: ${thread}`);
  return thread;
}

/** The attempt a thread names, or undefined for a thread the orchestrator did not create. */
export function parseAttemptThread(thread: string): { runId: string; nodeId: string; n: number } | undefined {
  const m = /^(run_[0-9A-Z]+)\.(.+)\.a(\d+)$/.exec(thread);
  if (!m) return undefined;
  return { runId: m[1]!, nodeId: m[2]!, n: Number(m[3]) };
}

/** The attempt id for a thread: the thread itself, so events can be routed without a lookup. */
export function attemptIdOf(thread: string): string {
  return `att_${thread}`;
}
