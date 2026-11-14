import { enqueue, type Intent } from "@rovara-orch/core";
import { ConditionFailed, gsi, intentOps, type Op } from "@rovara-orch/store";
import { EXECUTORS } from "./effects/registry.js";
import { Deferred } from "./effects/deferred.js";
import type { Executor } from "./effects/types.js";

export { Deferred };
import type { Deps } from "./ports.js";

export const MAX_TRIES = 8;


/** Exponential back-off: 10 s, 20 s, 40 s ... capped at 30 minutes. */
export function backoffMs(tries: number): number {
  return Math.min(10_000 * 2 ** (tries - 1), 30 * 60_000);
}

/** The queue group an intent's owner listens on, so a failed intent can be reported to it. */
function ownerGroup(pk: string): string | undefined {
  if (pk.startsWith("ATT#")) return `att:${pk.slice(4)}`;
  if (pk.startsWith("RUN#")) return `run:${pk.slice(4)}`;
  return undefined;
}

/**
 * Carry out one intent and record the outcome. Safe to call more than once for the same intent
 * (stream redelivery, sweep re-drive, a restart): an intent no longer pending is skipped, and
 * executors are idempotent by the intent's key.
 */
export async function runIntent(
  deps: Deps,
  ref: { pk: string; sk: string },
  executors: Record<string, Executor> = EXECUTORS,
): Promise<"done" | "retry" | "failed" | "skipped" | "deferred"> {
  const intent = await deps.table.get<Intent>(ref);
  if (!intent || intent.status !== "pending") return "skipped";
  const now = deps.clock.now();
  const executor = executors[intent.effect];
  try {
    if (!executor) throw new Error(`unknown effect ${intent.effect}`);
    const result = await executor(intent, deps);
    await deps.table.transact([
      {
        kind: "update",
        key: ref,
        set: { status: "done", result, doneAt: now.toISOString(), gsi1pk: undefined, gsi1sk: undefined },
        ifExists: true,
      },
    ]);
    return "done";
  } catch (e) {
    if (e instanceof Deferred) {
      const nextTryAt = new Date(now.getTime() + e.retryInMs).toISOString();
      await deps.table.transact([
        { kind: "update", key: ref, set: { nextTryAt, lastError: e.message, ...gsi.pendingIntent(nextTryAt, ref.pk, ref.sk) }, ifExists: true },
      ]);
      return "deferred";
    }
    const tries = intent.tries + 1;
    const error = e instanceof Error ? e.message : String(e);
    deps.log?.({ event: "intent.failed_try", effect: intent.effect, key: intent.key, tries, error });
    // A Slack notification is never given up on: it stays pending, and visible on the run, until delivered (FR-035).
    const keepTrying = intent.effect === "slack.post" || intent.effect === "slack.reply";
    if (tries >= MAX_TRIES && !keepTrying) {
      const ops: Op[] = [
        { kind: "update", key: ref, set: { status: "failed", tries, lastError: error, gsi1pk: undefined, gsi1sk: undefined }, ifExists: true },
      ];
      const group = ownerGroup(intent.pk);
      if (group) {
        const report = enqueue(
          { group: group as `att:${string}`, input: { kind: "intent_failed", effect: intent.effect, key: intent.key, error } },
          `failed:${intent.key}`,
        );
        ops.push(...intentOps(intent.pk, [report], now.toISOString()).ops);
      }
      await deps.table.transact(ops).catch((err: unknown) => {
        if (!(err instanceof ConditionFailed)) throw err;
      });
      deps.log?.({ event: "intent.failed", effect: intent.effect, key: intent.key, tries, error }); // alarmed (T122)
      return "failed";
    }
    const nextTryAt = new Date(now.getTime() + backoffMs(tries)).toISOString();
    await deps.table.transact([
      { kind: "update", key: ref, set: { tries, nextTryAt, lastError: error, ...gsi.pendingIntent(nextTryAt, ref.pk, ref.sk) }, ifExists: true },
    ]);
    return "retry";
  }
}
