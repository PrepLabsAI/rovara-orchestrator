import { updateRequest } from "../../text/update-request.js";
import { currentPr, Draft, escalate } from "../steps.js";
import type { AttemptHandler } from "../types.js";

/**
 * Conflicts (FR-042). A PR that conflicts with main, leaves the merge queue out of date, or fails
 * its checks in the queue against the latest main is asked to update from main while PR updates
 * remain, then escalates. Its new head is queued again by the normal path once it passes. A PR
 * dropped from the queue because main itself is red waits for main, with no update used.
 */
export const conflicts: AttemptHandler = (ctx, input) => {
  if (input.kind !== "github") return undefined;
  const e = input.event;
  const pr = currentPr(ctx.attempt);
  if (!pr || e.number !== pr.number) return undefined;
  let reason: "conflict" | "out_of_date" | "failed_checks" | "other";
  if (e.type === "merge_group" && e.status === "removed") {
    if (ctx.attempt.phase !== "queued") return undefined;
    reason = e.reason ?? "other";
  } else if (e.type === "conflict") {
    if (e.headSha !== pr.headSha) return undefined;
    reason = "conflict";
  } else {
    return undefined;
  }

  const d = new Draft(ctx);
  const a = d.attempt;
  a.phase = "pr_open";
  a.ci = { ...a.ci, queue: "none" };
  if (ctx.repo.paused) {
    d.move("pr_open");
    return d.done(); // main is red: released when it is green again
  }
  if (d.node.prUpdates >= ctx.run.retry.prUpdates) {
    escalate(d, `the PR needed another update from main (${reason}) after ${ctx.run.retry.prUpdates} updates`);
    return d.done();
  }
  const n = d.node.prUpdates + 1;
  d.intent("rovara.message", `${a.attemptId}.update.${n}`, { text: updateRequest({ reason, mainCommit: ctx.repo.mainCommit, failing: a.ci.failing }) });
  d.move("pr_open", { prUpdates: n });
  return d.done();
};
