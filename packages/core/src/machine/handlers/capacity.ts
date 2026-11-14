import { nextStartRate } from "../../backoff.js";
import { enqueue } from "../helpers.js";
import { Draft } from "../steps.js";
import { ORCHESTRATOR, type AttemptHandler, type RepoHandler, type RunHandler } from "../types.js";

/**
 * Attempt-level capacity (FR-062): Rovara refused the start because its workspace limit is reached.
 * The node goes back to waiting and the refused attempt does not count toward its limit; the
 * repository is told, so starts there wait a minute before Rovara is tried again.
 */
export const capacity: AttemptHandler = (ctx, input) => {
  if (input.kind !== "rovara" || input.type !== "error" || input.data.code !== "workspace_limit") return undefined;
  const d = new Draft(ctx);
  const a = d.attempt;
  a.phase = "abandoned";
  a.outcome = "abandoned";
  a.outcomeReason = "workspace_limit";
  a.endedAt = ctx.now;
  a.due = { quietAt: null, reviewAt: null, retryAt: null };
  d.move("waiting", { waitingFor: { reason: "capacity", detail: "Rovara's workspace limit is reached" }, refusedStarts: (ctx.node.refusedStarts ?? 0) + 1 });
  d.intents.push(enqueue({ group: `repo:${ctx.run.repo}`, input: { kind: "workspace_limit_hit" } }, `wl-hit:${a.attemptId}`));
  return d.done();
};

/**
 * Run-level capacity (FR-061): at run start, a concurrency above Rovara's project workspace limit
 * asks Rovara to raise it, when the acting-for operator is a Rovara administrator. Otherwise the
 * run starts at the current limit, and the scheduler shows why the rest wait.
 */
export const runCapacity: RunHandler = (ctx, input) => {
  if (input.kind !== "run_start") return undefined;
  const limit = ctx.repo.rovaraProjectLimit;
  if (limit === null || ctx.run.concurrencyLimit <= limit) return undefined;
  if (!ctx.actingForIsAdmin) {
    return {
      intents: [],
      decisions: [{ actor: ORCHESTRATOR, action: "refused", reason: `concurrency ${ctx.run.concurrencyLimit} is above Rovara's project limit of ${limit}, and ${ctx.run.actingFor} is not a Rovara administrator; the run starts at the current limit` }],
    };
  }
  return {
    intents: [
      {
        effect: "rovara.workspace_limit",
        key: `wl:${ctx.run.repo}:${ctx.run.runId}`,
        payload: { repo: ctx.run.repo, openWorkspaces: ctx.run.concurrencyLimit, openWorkspacesPerPerson: ctx.run.concurrencyLimit, by: ctx.run.actingFor },
      },
    ],
    decisions: [{ actor: ORCHESTRATOR, action: "start", reason: `asked Rovara to raise its project limit from ${limit} to ${ctx.run.concurrencyLimit}` }],
  };
};

/** Repository-level capacity and back-off (FR-062, FR-063). */
export const repoCapacity: RepoHandler = (ctx, input) => {
  if (input.kind === "workspace_limit_hit") {
    return { repo: { ...ctx.repo, rovaraFreeWorkspaces: 0, workspaceLimitAt: ctx.now }, intents: [], decisions: [] };
  }
  if (input.kind === "rate_window") {
    if ((ctx.repo.rateWindow ?? -1) >= input.window) return undefined;
    const startRate = nextStartRate({ current: ctx.repo.startRate, requests: input.requests, throttled: input.throttled, concurrencyLimit: input.concurrencyLimit });
    return { repo: { ...ctx.repo, startRate, rateWindow: input.window }, intents: [], decisions: [] };
  }
  return undefined;
};
