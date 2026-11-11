import { createHash } from "node:crypto";
import { enqueueMany, type AttemptInput, type GithubAttemptEvent, type Intent, type QueueMessage } from "@rovara-orch/core";
import { intentOps } from "@rovara-orch/store";
import { reviewState } from "./github-events/lookups.js";
import type { Deps } from "./ports.js";

const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 32);

/**
 * Read a PR's state from GitHub and turn it into the inputs its webhooks would have produced
 * (constitution III: read the record rather than guess). Covers webhooks that arrived before the
 * attempt knew its PR, and webhooks that were lost. Each input's id is derived from its content, so
 * an unchanged PR produces inputs the consumer has already seen.
 */
export async function reconcileMessages(deps: Deps, attemptId: string): Promise<QueueMessage[]> {
  const attempt = await deps.repos.getAttempt(attemptId);
  const pr = attempt?.pullRequests.at(-1);
  if (!attempt || !pr || pr.state !== "open") return [];
  const run = await deps.repos.getRun(attempt.runId);
  if (!run) return [];
  const repo = run.repo;
  const info = await deps.github.getPull(repo, pr.number);
  const events: GithubAttemptEvent[] = [];
  if (info.state === "merged" && info.mergeCommit) {
    if (await deps.github.isReachableFromMain(repo, info.mergeCommit)) events.push({ type: "merged_on_main", number: pr.number, mergeCommit: info.mergeCommit });
  } else if (info.state === "closed") {
    events.push({ type: "pr_closed", number: pr.number, merged: false, mergeCommit: null });
  } else {
    events.push({ type: "pr_synchronize", number: pr.number, headSha: info.headSha, baseRef: info.baseRef, repo: info.repo, changedFiles: info.changedFiles });
    const { status, failing } = await deps.github.checksForSha(repo, info.headSha);
    events.push({ type: "checks", number: pr.number, headSha: info.headSha, scope: "pr", status, failing });
    events.push(await reviewState(deps, repo, pr.number, info.headSha));
  }
  return events.map((event) => {
    const input: AttemptInput = { kind: "github", deliveryId: `reconcile:${digest(event)}`, event };
    return { group: `att:${attemptId}`, input, inputId: `reconcile:${attemptId}:${event.type}:${digest(event)}` } as QueueMessage;
  });
}

/** The `reconcile_pr` repository input: write the inputs as one enqueue intent (never a direct send). */
export async function reconcile(deps: Deps, repo: string, attemptId: string): Promise<Intent[]> {
  const messages = await reconcileMessages(deps, attemptId);
  if (!messages.length) return [];
  const now = deps.clock.now().toISOString();
  const { ops, intents } = intentOps(`REPO#${repo}`, [enqueueMany(messages, `reconcile:${attemptId}:${digest(messages.map((m) => m.inputId))}`)], now);
  await deps.table.transact(ops);
  return intents;
}
