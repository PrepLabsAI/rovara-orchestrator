import { rateWindowOf, type Attempt, type Intent, type QueueMessage } from "@rovara-orch/core";
import { readMinutes, windowMinutes } from "@rovara-orch/store";
import { runIntent } from "./intent-runner.js";
import { expireEndedTraces } from "./sweep-trace-expiry.js";
import type { Deps } from "./ports.js";

/** Intents younger than this are left to the table stream; older pending ones are re-driven. */
export const REDRIVE_AFTER_MS = 30_000;

function timerMessages(a: Attempt, now: string): QueueMessage[] {
  const out: QueueMessage[] = [];
  for (const timer of ["quiet", "review", "retry"] as const) {
    const at = a.due[`${timer}At` as const];
    if (at && at <= now) {
      out.push({ group: `att:${a.attemptId}`, input: { kind: "timer", timer, at }, inputId: `timer:${a.attemptId}:${timer}:${at}` });
    }
  }
  return out;
}

/**
 * Runs every minute. The one place allowed to send to the queue directly: everything it sends is
 * recomputed from stored state each minute, so a lost send is repeated by the next sweep.
 */
export async function runSweep(deps: Deps): Promise<{ timers: number; redriven: number; passes: number }> {
  const now = deps.clock.now();
  const nowIso = now.toISOString();

  const due = await deps.repos.listDue(nowIso);
  const timers = due.flatMap((a) => timerMessages(a, nowIso));
  if (timers.length) await deps.queue.send(timers);

  const cutoff = new Date(now.getTime() - REDRIVE_AFTER_MS).toISOString();
  const pending = await deps.table.queryIndex<Intent>("PENDING_INTENT", { upTo: `${cutoff}#￿`, limit: 500 });
  for (const intent of pending) await runIntent(deps, intent);

  const runs = await deps.repos.listActiveRuns();
  const repos = [...new Set(runs.map((r) => r.repo))];
  const minute = Math.floor(now.getTime() / 60_000);
  if (!repos.length) deps.log?.({ event: "sweep.no_active_runs" }); // nothing to schedule: not a stalled scheduler
  if (repos.length) {
    await deps.queue.send(repos.map((repo) => ({ group: `repo:${repo}`, input: { kind: "schedule" }, inputId: `sweep-sched:${repo}:${minute}` })));
  }

  // Reconcile every attempt with an open PR against GitHub, in case a webhook was lost.
  const reconciles: QueueMessage[] = [];
  for (const run of runs) {
    for (const n of await deps.repos.getRunNodes(run.runId)) {
      if ((n.state === "pr_open" || n.state === "in_merge_queue") && n.currentAttempt) {
        reconciles.push({ group: `repo:${run.repo}`, input: { kind: "reconcile_pr", attemptId: n.currentAttempt }, inputId: `sweep-reconcile:${n.currentAttempt}:${minute}` });
      }
    }
  }
  if (reconciles.length) await deps.queue.send(reconciles);

  // A paused repository is read afresh every minute, so it resumes even if main's green check events were lost.
  const paused = (await Promise.all(repos.map((r) => deps.repos.getRepo(r)))).filter((r) => r.paused);
  if (paused.length) {
    await deps.queue.send(paused.map((r) => ({ group: `repo:${r.repo}`, input: { kind: "recheck_main" }, inputId: `recheck-main:${r.repo}:${minute}` })));
  }
  // Each finished 5-minute window becomes the repository's next start rate (FR-063).
  const lastWindow = rateWindowOf(now) - 1;
  const windows: QueueMessage[] = [];
  for (const repo of repos) {
    if (((await deps.repos.getRepo(repo)).rateWindow ?? -1) >= lastWindow) continue;
    const [from, to] = windowMinutes(lastWindow);
    const counts = await readMinutes(deps.table, repo, from, to);
    const concurrencyLimit = Math.max(...runs.filter((r) => r.repo === repo).map((r) => r.concurrencyLimit));
    windows.push({ group: `repo:${repo}`, input: { kind: "rate_window", window: lastWindow, requests: counts.requests, throttled: counts.throttled, concurrencyLimit }, inputId: `rate:${repo}:${lastWindow}` });
  }
  if (windows.length) await deps.queue.send(windows);

  await expireEndedTraces(deps);
  return { timers: timers.length, redriven: pending.length, passes: repos.length };
}
