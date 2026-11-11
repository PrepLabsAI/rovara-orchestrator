import { ACTIVE_NODE_STATES, FINAL_ATTEMPT_PHASES, FINAL_NODE_STATES, type NodeRunState } from "../../model.js";
import { enqueueMany, mergeCounters, moveNode, type QueueMessage } from "../helpers.js";
import { prNumberFromUrl } from "./happy-path.js";
import { Draft } from "../steps.js";
import type { AttemptContext, AttemptHandler, AttemptInput, AttemptTransition, Counters, NodeActionInput, RunHandler, RunTransition } from "../types.js";

/** Attempt-level controls: being cancelled by the run (FR-050). Release of a held approval is in happy-path. */
export const controls: AttemptHandler = (ctx, input) => {
  if (input.kind !== "control" || input.action !== "cancel") return undefined;
  if (FINAL_ATTEMPT_PHASES.includes(ctx.attempt.phase) || FINAL_NODE_STATES.includes(ctx.node.state)) return undefined;
  const d = new Draft(ctx);
  const a = d.attempt;
  d.intent("rovara.cancel", `${a.attemptId}.cancel`, {});
  d.intent("rovara.close", `${a.attemptId}.close`, {});
  for (const pr of a.pullRequests.filter((p) => p.state === "open")) {
    d.intent("github.close_pr", `closepr:${ctx.dag.repo}:${pr.number}`, { repo: ctx.dag.repo, number: pr.number });
  }
  a.phase = "cancelled";
  a.outcome = "cancelled";
  a.outcomeReason = input.reason;
  a.endedAt = ctx.now;
  a.due = { quietAt: null, reviewAt: null, retryAt: null };
  d.move("cancelled", { waitingFor: null });
  d.decide("cancel", input.reason, undefined, input.by);
  return d.done();
};

/**
 * A PR Rovara reports after its attempt was cancelled is closed, not adopted: a cancelled run leaves
 * no unmerged PR open (FR-050). The attempt keeps the PR on record so a repeat closes nothing new.
 */
export function latePrAfterCancel(ctx: AttemptContext, input: AttemptInput): AttemptTransition | undefined {
  if (ctx.attempt.phase !== "cancelled" || input.kind !== "rovara" || input.type !== "pr") return undefined;
  const url = String(input.data.url);
  const number = prNumberFromUrl(url);
  if (number === null || ctx.attempt.pullRequests.some((p) => p.number === number)) return undefined;
  const d = new Draft(ctx);
  d.attempt.pullRequests.push({ number, url, headSha: null, state: "closed", openedAt: ctx.now, changedFiles: null, baseRef: null, repo: null, mergeCommit: null });
  d.intent("github.close_pr", `closepr:${ctx.dag.repo}:${number}`, { repo: ctx.dag.repo, number });
  return d.done();
}

const RESOLVED = { retry: "retried", skip: "skipped", cancel: "cancelled" } as const;

/**
 * An operator's retry, skip or cancel of an escalated node (FR-033). Each closes the failed
 * attempt's workspace and open PR, replies in the escalation's Slack thread (FR-035), and records
 * who chose it and why. Retry gives the node a fresh set of attempts and PR limits; skip completes
 * it without a merge, shown as skipped.
 */
export function nodeActions(ctx: AttemptContext, input: NodeActionInput): AttemptTransition | undefined {
  if (ctx.node.state !== "escalated" || ctx.node.currentAttempt !== ctx.attempt.attemptId) return undefined;
  const d = new Draft(ctx);
  const a = d.attempt;
  d.intent("rovara.close", `${a.attemptId}.close`, {});
  for (const pr of a.pullRequests.filter((p) => p.state === "open")) {
    d.intent("github.close_pr", `closepr:${ctx.dag.repo}:${pr.number}`, { repo: ctx.dag.repo, number: pr.number });
    pr.state = "closed";
  }
  const slackKey = ctx.node.escalation?.slackKey;
  if (slackKey) {
    d.intents.push({
      effect: "slack.reply",
      key: `reply:${slackKey}:${input.decisionId}`,
      payload: { attemptId: a.attemptId, replyTo: slackKey, template: "nodeResolved", params: { action: RESOLVED[input.action], operator: input.by, reason: input.reason } },
    });
  }
  if (input.action === "retry") {
    d.move("eligible", { escalation: null, waitingFor: null, attemptsBeforeRetry: ctx.node.attempts, prUpdates: 0, reviewRounds: 0 });
  } else if (input.action === "skip") {
    d.move("skipped", { escalation: null, waitingFor: null, skippedBy: { operator: input.by, reason: input.reason, at: ctx.now } });
  } else {
    d.move("cancelled", { escalation: null, waitingFor: null });
  }
  d.decide(input.action, input.reason, { decisionId: input.decisionId }, input.by);
  return d.done();
}

/** Run-level controls: pause, resume and cancel (FR-050). Take-over and pauses for cost and access are US5. */
export const runControls: RunHandler = (ctx, input) => {
  const run = ctx.run;
  switch (input.kind) {
    case "pause": {
      if (run.state !== "running") return undefined;
      return {
        run: { ...run, state: "paused", pausedFor: "operator" },
        intents: [],
        decisions: [{ actor: input.by, action: "pause", reason: input.reason, detail: { decisionId: input.decisionId } }],
      };
    }
    case "resume": {
      if (run.state !== "paused") return undefined;
      return {
        run: { ...run, state: "running", pausedFor: null },
        intents: [],
        decisions: [{ actor: input.by, action: "resume", reason: input.reason, detail: { decisionId: input.decisionId } }],
      };
    }
    case "cancel": {
      if (run.state === "cancelled" || run.state === "complete") return undefined;
      const direct: NodeRunState[] = [];
      let counters: Counters = {};
      const messages: QueueMessage[] = [];
      for (const n of ctx.nodes) {
        if (FINAL_NODE_STATES.includes(n.state)) continue;
        if (ACTIVE_NODE_STATES.includes(n.state) && n.currentAttempt) {
          messages.push({
            group: `att:${n.currentAttempt}`,
            input: { kind: "control", action: "cancel", by: input.by, reason: input.reason },
            inputId: `cancel:${n.currentAttempt}:${input.decisionId}`,
          });
        } else {
          const moved = moveNode(n, "cancelled", { waitingFor: null });
          direct.push(moved.node);
          counters = mergeCounters(counters, moved.counters);
        }
      }
      const t: RunTransition = {
        run: { ...run, state: "cancelled", endedAt: ctx.now, pausedFor: null },
        nodes: direct,
        intents: messages.length ? [enqueueMany(messages, `cancel-fanout:${run.runId}:${input.decisionId}`)] : [],
        decisions: [{ actor: input.by, action: "cancel", reason: input.reason, detail: { decisionId: input.decisionId } }],
        counters,
        records: [{ kind: "delete", key: { pk: `DAGRUN#${run.dagId}`, sk: "ACTIVE" } }],
      };
      return t;
    }
    default:
      return undefined;
  }
};
