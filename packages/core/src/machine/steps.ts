/**
 * Steps shared by the attempt handlers: queueing a merge, escalating, and building transitions.
 */
import { addMinutes } from "../clock.js";
import { canMerge } from "../merge-gate.js";
import type { Attempt, DecisionSpec, IntentSpec, NodeRunState } from "../model.js";
import { mergeCounters, moveNode } from "./helpers.js";
import { ORCHESTRATOR, type AttemptContext, type AttemptTransition, type Counters, type RecordWrite } from "./types.js";

export const REVIEW_WAIT_MINUTES = 30;

/** A transition being built up by a handler. */
export class Draft {
  attempt: Attempt;
  node: NodeRunState;
  intents: IntentSpec[] = [];
  decisions: DecisionSpec[] = [];
  records: RecordWrite[] = [];
  counters: Counters = {};

  constructor(readonly ctx: AttemptContext) {
    this.attempt = structuredClone(ctx.attempt);
    this.node = structuredClone(ctx.node);
  }

  move(to: NodeRunState["state"], patch: Partial<NodeRunState> = {}): void {
    const { node, counters } = moveNode(this.node, to, patch);
    this.node = node;
    this.counters = mergeCounters(this.counters, counters);
  }

  intent(effect: IntentSpec["effect"], key: string, payload: Record<string, unknown>): void {
    this.intents.push({ effect, key, payload: { attemptId: this.attempt.attemptId, ...payload } });
  }

  decide(action: DecisionSpec["action"], reason: string, detail?: Record<string, unknown>, actor = ORCHESTRATOR): void {
    this.decisions.push({ actor, action, reason, nodeId: this.node.nodeId, attemptId: this.attempt.attemptId, ...(detail ? { detail } : {}) });
  }

  done(): AttemptTransition {
    const nodeChanged = JSON.stringify(this.node) !== JSON.stringify(this.ctx.node);
    const attemptChanged = JSON.stringify(this.attempt) !== JSON.stringify(this.ctx.attempt);
    return {
      ...(attemptChanged ? { attempt: this.attempt } : {}),
      ...(nodeChanged ? { node: this.node } : {}),
      intents: this.intents,
      decisions: this.decisions,
      ...(Object.keys(this.counters).length ? { counters: this.counters } : {}),
      ...(this.records.length ? { records: this.records } : {}),
    };
  }
}

export const currentPr = (a: Attempt) => a.pullRequests.at(-1);

/** Queue the current PR when every merge condition holds (FR-040, FR-041). */
export function tryEnqueue(d: Draft): void {
  const pr = currentPr(d.attempt);
  if (!pr || !pr.headSha) return;
  if (d.attempt.phase === "queued" || d.attempt.phase === "merged") return;
  const { ok } = canMerge({ attempt: d.attempt, prNumber: pr.number, dagRepo: d.ctx.dag.repo, repo: d.ctx.repo, settings: d.ctx.settings });
  if (!ok) return;
  d.intent("github.enqueue", `enqueue:${d.ctx.dag.repo}:${pr.number}:${pr.headSha}`, { repo: d.ctx.dag.repo, number: pr.number, headSha: pr.headSha });
  d.attempt.phase = "queued";
  d.attempt.ci.queue = "pending";
  d.attempt.due.reviewAt = null;
  d.move("in_merge_queue");
  d.decide("merge", "every merge condition holds", { number: pr.number, headSha: pr.headSha });
}

/** Escalate the node: a person is told in Slack, its dependents stay blocked (FR-032, FR-035). */
export function escalate(d: Draft, reason: string, template: "nodeEscalated" | "adminRequest" = "nodeEscalated"): void {
  const key = `esc:${d.attempt.attemptId}:${d.node.attempts}`;
  const pr = currentPr(d.attempt);
  d.intent("slack.post", key, {
    template,
    params: { runId: d.ctx.run.runId, nodeId: d.node.nodeId, reason, rovaraTask: d.attempt.rovaraTaskUrl, pullRequest: pr?.url ?? null },
  });
  d.attempt.phase = "failed";
  d.attempt.outcome = "failed";
  d.attempt.outcomeReason = reason;
  d.attempt.endedAt = d.ctx.now;
  d.attempt.due = { quietAt: null, reviewAt: null, retryAt: null };
  d.move("escalated", { escalation: { at: d.ctx.now, reason, slackTs: null, slackKey: key }, waitingFor: null });
  d.decide("escalate", reason);
}

export function reviewDue(now: string): string {
  return addMinutes(now, REVIEW_WAIT_MINUTES);
}

export function quietDue(ctx: AttemptContext): string {
  return addMinutes(ctx.now, ctx.run.retry.quietMinutes);
}

/** Whether the node may start another attempt; an operator retry gives it a fresh set (FR-030, FR-033). */
export function attemptsLeft(d: Draft): boolean {
  return d.node.attempts < d.ctx.run.retry.attempts + (d.node.attemptsBeforeRetry ?? 0);
}

/**
 * End this attempt and let the scheduler start a new one in a new conversation (FR-031): its
 * workspace is closed, and its open PR closed. The node goes back to `eligible`.
 */
export function abandon(d: Draft, reason: string): void {
  const a = d.attempt;
  d.intent("rovara.close", `${a.attemptId}.close`, {});
  for (const pr of a.pullRequests.filter((p) => p.state === "open")) {
    d.intent("github.close_pr", `closepr:${d.ctx.dag.repo}:${pr.number}`, { repo: d.ctx.dag.repo, number: pr.number });
    pr.state = "closed";
  }
  a.phase = "abandoned";
  a.outcome = "abandoned";
  a.outcomeReason = reason;
  a.endedAt = d.ctx.now;
  a.due = { quietAt: null, reviewAt: null, retryAt: null };
  d.move("eligible", { waitingFor: null });
  d.decide("retry", `${reason}; starting attempt ${d.node.attempts + 1}`);
}

/** A failed attempt: a new one while attempts remain, else escalate (FR-031, FR-032). */
export function failAttempt(d: Draft, reason: string): void {
  if (attemptsLeft(d)) abandon(d, reason);
  else escalate(d, `${reason}; no attempts left`);
}

