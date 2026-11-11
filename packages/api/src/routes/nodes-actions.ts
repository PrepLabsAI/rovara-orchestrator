import type { Repositories } from "@rovara-orch/store";
import { ApiError } from "../errors.js";
import { recordAndEnqueue, type RecordContext } from "../record-and-enqueue.js";
import type { ApiResponse, Route, RouteContext } from "../types.js";
import { requireReason } from "./runs-control.js";

export type NodeAction = "retry" | "skip" | "cancel";

/**
 * Retry, skip or cancel an escalated node (FR-033): the decision and a `node_action` input for the
 * node's attempt in one transaction; the attempt machine applies it and checks the state again.
 */
export async function nodeAction(
  ctx: RecordContext & { deps: RecordContext["deps"] & { repos: Repositories } },
  runId: string,
  nodeId: string,
  action: NodeAction,
  reason: string,
): Promise<ApiResponse> {
  const node = await ctx.deps.repos.getRunNode(runId, nodeId);
  if (!node) throw new ApiError("NOT_FOUND", `no node ${nodeId} in run ${runId}`);
  if (node.state !== "escalated" || !node.currentAttempt) {
    throw new ApiError("CONFLICT", `${nodeId} is ${node.state}, not escalated`, { problem: "not_escalated" });
  }
  const attemptId = node.currentAttempt;
  return recordAndEnqueue(ctx, {
    runId,
    decision: { actor: ctx.operator.id, action, reason, nodeId, attemptId },
    message: (decisionId) => ({ group: `att:${attemptId}`, input: { kind: "node_action", action, by: ctx.operator.id, reason, decisionId } }),
  });
}

const route = (action: NodeAction) => (ctx: RouteContext) =>
  nodeAction(ctx, ctx.params.runId!, ctx.params.nodeId!, action, requireReason(ctx.req.body));

export const routes: Route[] = (["retry", "skip", "cancel"] as const).map((action) => ({
  method: "POST" as const,
  pattern: `/v1/runs/:runId/nodes/:nodeId/${action}`,
  handler: route(action),
}));
