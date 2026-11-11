import type { Attempt, Run } from "@rovara-orch/core";
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
