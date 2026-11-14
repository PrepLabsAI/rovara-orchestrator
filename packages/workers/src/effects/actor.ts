import { enqueue, type Attempt, type Intent, type Run } from "@rovara-orch/core";
import { ActorNotLinked } from "@rovara-orch/rovara";
import { intentOps } from "@rovara-orch/store";
import { Deferred } from "./deferred.js";
import type { ActorRef, Deps } from "../ports.js";

/** The attempt an intent belongs to, with its run: the conversation and the acting-for operator. */
export async function attemptAndRun(deps: Deps, attemptId: string): Promise<{ attempt: Attempt; run: Run; actor: ActorRef }> {
  const attempt = await deps.repos.getAttempt(attemptId);
  if (!attempt) throw new Error(`no attempt ${attemptId}`);
  const run = await deps.repos.getRun(attempt.runId);
  if (!run) throw new Error(`no run ${attempt.runId}`);
  // Every Rovara action is made for a named operator: the run's acting-for operator (FR-057).
  return { attempt, run, actor: { channel: deps.config.channel, tenant: deps.config.rovaraTenant, userId: run.actingFor } };
}

export const attemptIdOf = (payload: Record<string, unknown>): string => {
  const id = payload.attemptId;
  if (typeof id !== "string") throw new Error("intent payload has no attemptId");
  return id;
};

/**
 * Send one Rovara action for the intent's attempt, for the run's acting-for operator. While the run
 * is paused because Rovara stopped accepting work for that operator, nothing is sent. If Rovara
 * refuses the operator now, the run is told (it pauses) and the action is deferred, not failed.
 * Rovara has used every event id it refused, so after each such pause the id gets a new suffix;
 * the same action is never sent twice under one id.
 */
export async function deliver(
  deps: Deps,
  intent: Intent,
  send: (a: { attempt: Attempt; actor: ActorRef; eventId: string }) => Promise<void>,
): Promise<{ eventId: string; actor: string }> {
  const { attempt, run, actor } = await attemptAndRun(deps, attemptIdOf(intent.payload));
  if (run.state === "paused" && run.pausedFor === "lost_access") throw new Deferred(`run ${run.runId} is paused until someone takes it over`);
  const gen = run.accessGeneration ?? 0;
  const eventId = gen ? `${intent.key}.g${gen}` : intent.key;
  try {
    await send({ attempt, actor, eventId });
  } catch (e) {
    if (!(e instanceof ActorNotLinked)) throw e;
    const tell = enqueue({ group: `run:${run.runId}`, input: { kind: "lost_access", operator: actor.userId } }, `lost:${run.runId}:${actor.userId}:g${gen}`);
    await deps.table.transact(intentOps(`ATT#${attempt.attemptId}`, [tell], deps.clock.now().toISOString()).ops);
    throw new Deferred(e.message);
  }
  return { eventId, actor: actor.userId };
}
