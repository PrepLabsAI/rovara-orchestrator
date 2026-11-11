import { attemptIdOf, attemptThread } from "@rovara-orch/core";
import { expireTrace, keys } from "@rovara-orch/store";
import type { Deps } from "./ports.js";

/**
 * Once a run has ended, give its trace steps an expiry of `endedAt` + 90 days and record
 * `tracesExpireSetAt` on the run, once (FR-055). Steps are written without a TTL because the run's
 * end is not known when they arrive.
 */
export async function expireEndedTraces(deps: Deps, limit = 20): Promise<number> {
  const ended = (await deps.repos.listRuns(200)).filter((r) => (r.state === "complete" || r.state === "cancelled") && r.endedAt && !r.tracesExpireSetAt).slice(0, limit);
  for (const run of ended) {
    const nodes = await deps.repos.getRunNodes(run.runId);
    // Attempt ids follow from the node and attempt number, so every attempt of the run is covered.
    const attempts = nodes.flatMap((n) => Array.from({ length: n.attempts }, (_, i) => attemptIdOf(attemptThread(run.runId, n.nodeId, i + 1))));
    await expireTrace(deps.table, attempts, run.endedAt!);
    await deps.table.transact([{ kind: "update", key: keys.run(run.runId), set: { tracesExpireSetAt: deps.clock.now().toISOString() }, ifExists: true }]);
  }
  return ended.length;
}
