import { enqueue } from "../helpers.js";
import { CREATE_PR, nodeBrief } from "../../text/brief.js";
import { currentPr, Draft, quietDue, reviewDue, tryEnqueue } from "../steps.js";
import type { AttemptContext, AttemptHandler, AttemptInput, GithubAttemptEvent, RovaraInput } from "../types.js";

/** The PR number in a GitHub pull request URL (until Rovara#438 sends it typed). */
export function prNumberFromUrl(url: string): number | null {
  const m = /\/pull\/(\d+)(?:[/?#].*)?$/.exec(url);
  return m ? Number(m[1]) : null;
}

function onRovara(ctx: AttemptContext, input: RovaraInput) {
  const d = new Draft(ctx);
  const a = d.attempt;
  const data = input.data;
  a.due.quietAt = quietDue(ctx);
  switch (input.type) {
    case "ack": {
      if (a.phase !== "starting") return d.done();
      a.phase = "planning";
      return d.done();
    }
    case "approval_request": {
      if (data.kind !== "plan_approval" || !data.actions) return undefined; // admin / other / stepped-up: failures
      const requestId = String(data.requestId);
      if (a.plan?.requestId === requestId && (a.plan.approvedAt || a.plan.held)) return undefined;
      a.rovaraTaskUrl = typeof data.taskUrl === "string" ? data.taskUrl : a.rovaraTaskUrl;
      a.plan = { requestId, revision: Number(data.expectedRevision), digest: String(data.artifactDigest), approvedAt: null, held: false };
      if (ctx.settings.stopSwitch.on) {
        a.plan.held = true;
        return d.done();
      }
      approve(d);
      return d.done();
    }
    case "question": {
      d.intent("model.answer", `${a.attemptId}.answer.${input.eventId}`, {
        eventId: input.eventId,
        question: String(data.text),
        choices: Array.isArray(data.choices) ? data.choices : [],
      });
      d.decide("answer", "the agent asked a question; the answering model answers it", { eventId: input.eventId });
      return d.done();
    }
    case "check_report": {
      if (data.status !== "passed") return undefined; // failed / unknown: failures
      a.checkReports.push({ status: "passed", at: ctx.now, text: String(data.text ?? "") });
      if (d.node.state === "checks_failed") d.move(currentPr(a) ? "pr_open" : "running");
      if (!currentPr(a)) {
        if (a.phase !== "pr_requested") {
          a.phase = "pr_requested";
          d.intent("rovara.message", `${a.attemptId}.create-pr.${a.checkReports.length}`, { text: CREATE_PR });
        }
      } else {
        tryEnqueue(d);
      }
      return d.done();
    }
    case "pr": {
      const url = String(data.url);
      const number = prNumberFromUrl(url);
      if (number === null || a.pullRequests.some((p) => p.number === number)) return undefined;
      a.pullRequests.push({ number, url, headSha: null, state: "open", openedAt: ctx.now, changedFiles: null, baseRef: null, repo: null, mergeCommit: null });
      a.phase = "pr_open";
      a.due.reviewAt = reviewDue(ctx.now);
      d.move("pr_open");
      d.records.push({ kind: "put", key: { pk: `PRLINK#${ctx.dag.repo}#${number}`, sk: "META" }, attrs: { entityType: "PRLINK", attemptId: a.attemptId, number } });
      // Read the PR's state from GitHub now: its webhooks may have arrived before this event.
      d.intents.push(enqueue({ group: `repo:${ctx.dag.repo}`, input: { kind: "reconcile_pr", attemptId: a.attemptId } }, `reconcile:${a.attemptId}:${number}`));
      return d.done();
    }
    default:
      return undefined;
  }
}

function approve(d: Draft): void {
  const a = d.attempt;
  if (!a.plan) return;
  d.intent("rovara.decision", `${a.attemptId}.approve.${a.plan.requestId}`, {
    requestId: a.plan.requestId,
    expectedRevision: a.plan.revision,
    artifactDigest: a.plan.digest,
    decision: "APPROVE",
    reason: `The orchestrator approves plans for run ${d.ctx.run.runId}, node ${d.node.nodeId}.`,
  });
  a.plan.approvedAt = d.ctx.now;
  a.plan.held = false;
  if (a.phase === "starting" || a.phase === "planning") a.phase = "coding";
  d.decide("approve", "plan approval", { requestId: a.plan.requestId, revision: a.plan.revision });
}

function onGithub(ctx: AttemptContext, e: GithubAttemptEvent) {
  const d = new Draft(ctx);
  const a = d.attempt;
  const pr = a.pullRequests.find((p) => p.number === e.number);
  if (!pr) return undefined;
  switch (e.type) {
    case "pr_opened":
    case "pr_synchronize": {
      if (e.changedFiles === 0) return undefined; // no changes: failures
      const headChanged = pr.headSha !== e.headSha;
      pr.headSha = e.headSha;
      pr.changedFiles = e.changedFiles;
      pr.baseRef = e.baseRef;
      pr.repo = e.repo;
      if (headChanged) {
        a.review = { headSha: e.headSha, reviewedAt: null, rerequestedAt: null, unresolved: a.review.unresolved, sent: a.review.sent };
        a.ci = { headSha: e.headSha, pr: "pending", queue: "none", failing: [] };
        if (a.phase !== "queued" && a.phase !== "merged") a.due.reviewAt = reviewDue(ctx.now);
        d.records.push({ kind: "put", key: { pk: `PRHEAD#${ctx.dag.repo}#${e.headSha}`, sk: "META" }, attrs: { entityType: "PRHEAD", attemptId: a.attemptId, number: e.number } });
      }
      tryEnqueue(d);
      return d.done();
    }
    case "checks": {
      if (e.scope !== "pr" || e.headSha !== pr.headSha) return undefined;
      if (a.ci.headSha === e.headSha && a.ci.pr === e.status) return undefined;
      a.ci = { ...a.ci, headSha: e.headSha, pr: e.status, failing: e.failing };
      tryEnqueue(d);
      return d.done();
    }
    case "pr_closed": {
      if (!e.merged) return undefined; // closed by a person: failures
      pr.mergeCommit = e.mergeCommit;
      return d.done();
    }
    case "merged_on_main": {
      pr.state = "merged";
      pr.mergeCommit = e.mergeCommit;
      a.phase = "merged";
      a.outcome = "merged";
      a.endedAt = ctx.now;
      a.due = { quietAt: null, reviewAt: null, retryAt: null };
      d.move("merged", { mergeCommit: e.mergeCommit, waitingFor: null });
      d.intent("rovara.close", `${a.attemptId}.close`, {});
      return d.done();
    }
    case "merge_group": {
      if (e.status !== "entered") return undefined; // removed: conflicts
      a.ci.queue = "pending";
      return d.done();
    }
    default:
      return undefined;
  }
}

/** The normal path from start to merge (US2). */
export const happyPath: AttemptHandler = (ctx, input: AttemptInput) => {
  switch (input.kind) {
    case "start": {
      if (ctx.attempt.phase !== "starting") return undefined;
      const d = new Draft(ctx);
      d.attempt.due.quietAt = quietDue(ctx);
      d.intent("rovara.message", `${ctx.attempt.attemptId}.brief`, { text: nodeBrief({ dag: ctx.dag, node: ctx.dagNode, baseCommit: ctx.attempt.baseCommit }) });
      return d.done();
    }
    case "rovara":
      return onRovara(ctx, input);
    case "github":
      return onGithub(ctx, input.event);
    case "control": {
      // The stop switch went off: send a held plan approval, or queue a PR that became ready meanwhile.
      if (input.action !== "release" || ctx.settings.stopSwitch.on) return undefined;
      const d = new Draft(ctx);
      if (ctx.attempt.plan?.held) approve(d);
      else tryEnqueue(d);
      return d.intents.length ? d.done() : undefined;
    }
    case "answered": {
      const d = new Draft(ctx);
      d.attempt.costUsd += input.costUsd;
      d.counters = { costUsd: input.costUsd };
      // The run's total is added atomically elsewhere; the run checks its stored total (FR-052).
      if (ctx.run.costUsd + input.costUsd >= ctx.run.costLimitUsd) {
        d.intents.push(enqueue({ group: `run:${ctx.run.runId}`, input: { kind: "cost_limit" } }, `cost-limit:${ctx.run.runId}:${input.eventId}`));
      }
      return d.done();
    }
    default:
      return undefined;
  }
};
