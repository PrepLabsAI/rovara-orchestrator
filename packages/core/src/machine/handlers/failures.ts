import { fixRequest } from "../../text/fix-request.js";
import { Draft, escalate, failAttempt } from "../steps.js";
import type { AttemptContext, AttemptHandler, AttemptInput, AttemptTransition, GithubAttemptEvent, RovaraInput } from "../types.js";

/** Rovara error codes that are not failures of the work: capacity and back-off handle them (US6). */
const NOT_FAILURES = new Set(["workspace_limit", "throttled"]);

function onRovara(ctx: AttemptContext, input: RovaraInput): AttemptTransition | undefined {
  const d = new Draft(ctx);
  const a = d.attempt;
  const data = input.data;
  switch (input.type) {
    case "check_report": {
      const status = data.status === "unknown" ? "unknown" : "failed";
      a.checkReports.push({ status, at: ctx.now, text: String(data.text ?? "") });
      if (a.fixRequests < ctx.run.retry.fixRequests) {
        a.fixRequests++;
        d.intent("rovara.message", `${a.attemptId}.fix.${a.fixRequests}`, { text: fixRequest(a.checkReports) });
        d.move("checks_failed");
        return d.done();
      }
      failAttempt(d, `checks ${status} after ${ctx.run.retry.fixRequests} fix requests`);
      return d.done();
    }
    case "error": {
      const code = String(data.code);
      if (NOT_FAILURES.has(code)) return undefined;
      failAttempt(d, `Rovara reported an error (${code}): ${String(data.text ?? "")}`);
      return d.done();
    }
    case "approval_request": {
      if (typeof data.taskUrl === "string") a.rovaraTaskUrl = data.taskUrl;
      if (data.kind === "admin") escalate(d, "Rovara asks for an administrator's confirmation", "adminRequest");
      else if (data.kind !== "plan_approval") escalate(d, `Rovara asks for a confirmation the orchestrator does not give (${String(data.kind)})`);
      else escalate(d, "adapter registered with step-up");
      return d.done();
    }
    default:
      return undefined;
  }
}

function onGithub(ctx: AttemptContext, e: GithubAttemptEvent): AttemptTransition | undefined {
  const pr = ctx.attempt.pullRequests.find((p) => p.number === e.number);
  if (!pr || pr.state !== "open") return undefined;
  const d = new Draft(ctx);
  const own = d.attempt.pullRequests.find((p) => p.number === e.number)!;
  if (e.type === "pr_closed" && !e.merged) {
    own.state = "closed";
    failAttempt(d, `PR #${e.number} was closed without merging`);
    return d.done();
  }
  if ((e.type === "pr_opened" || e.type === "pr_synchronize") && e.changedFiles === 0) {
    own.headSha = e.headSha;
    own.changedFiles = 0;
    failAttempt(d, "no_changes");
    return d.done();
  }
  return undefined;
}

/**
 * Failures (FR-030 to FR-032, FR-034): failed or unknown checks get fix requests, then new
 * attempts, then escalation; workspace and conversation errors and PRs closed by hand get a new
 * attempt or escalate; requests the orchestrator never approves, and quiet attempts, escalate.
 */
export const failures: AttemptHandler = (ctx, input: AttemptInput) => {
  switch (input.kind) {
    case "rovara":
      return onRovara(ctx, input);
    case "github":
      return onGithub(ctx, input.event);
    case "timer": {
      if (input.timer !== "quiet" || input.at !== ctx.attempt.due.quietAt) return undefined;
      // Until Rovara#437 the state cannot be read, so the attempt is escalated, never retried:
      // a second workspace must not start for work that may still be running (FR-034).
      const d = new Draft(ctx);
      escalate(d, `no news from Rovara for ${ctx.run.retry.quietMinutes} minutes`);
      return d.done();
    }
    case "intent_failed": {
      if (input.effect.startsWith("slack.")) return undefined; // the notification itself; it stays visible as pending
      const d = new Draft(ctx);
      escalate(d, `the orchestrator could not carry out ${input.effect}: ${input.error}`);
      return d.done();
    }
    default:
      return undefined;
  }
};
