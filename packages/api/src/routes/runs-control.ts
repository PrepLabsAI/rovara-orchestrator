import type { DecisionAction } from "@rovara-orch/core";
import type { Repositories } from "@rovara-orch/store";
import { ApiError } from "../errors.js";
import { recordAndEnqueue, type RecordContext } from "../record-and-enqueue.js";
import type { ApiResponse, Route, RouteContext } from "../types.js";

export function requireReason(body: unknown): string {
  const reason = (body as { reason?: unknown } | undefined)?.reason;
  if (typeof reason !== "string" || !reason.trim()) throw new ApiError("INVALID", "a reason is required", { problem: "reason" });
  return reason.trim();
}

export type RunControl = "pause" | "resume" | "cancel" | "take_over";

/** Pause, resume or cancel: the decision and a `run:` input in one transaction; the run machine applies it. */
export async function controlRun(
  ctx: RecordContext & { deps: RecordContext["deps"] & { repos: Repositories } },
  runId: string,
  kind: RunControl,
  action: DecisionAction,
  reason: string,
): Promise<ApiResponse> {
  const run = await ctx.deps.repos.getRun(runId);
  if (!run) throw new ApiError("NOT_FOUND", `no run ${runId}`);
  return recordAndEnqueue(ctx, {
    runId,
    decision: { actor: ctx.operator.id, action, reason },
    message: (decisionId) => ({ group: `run:${runId}`, input: { kind, by: ctx.operator.id, reason, decisionId } }),
  });
}

export function control(kind: RunControl, action: DecisionAction) {
  return (ctx: RouteContext) => controlRun(ctx, ctx.params.runId!, kind, action, requireReason(ctx.req.body));
}

export const routes: Route[] = [
  { method: "POST", pattern: "/v1/runs/:runId/pause", handler: control("pause", "pause") },
  { method: "POST", pattern: "/v1/runs/:runId/resume", handler: control("resume", "resume") },
  { method: "POST", pattern: "/v1/runs/:runId/cancel", handler: control("cancel", "cancel") },
  { method: "POST", pattern: "/v1/runs/:runId/take-over", handler: control("take_over", "take_over") },
];
