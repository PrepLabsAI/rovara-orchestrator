import { enqueue, newId, type DecisionSpec, type WorkMessage } from "@rovara-orch/core";
import { ConditionFailed, decisionOps, intentOps, type Op } from "@rovara-orch/store";
import { storedResult, storeResultOp } from "./idempotency.js";
import type { ApiResponse, RouteContext } from "./types.js";

/**
 * Write the decision record, the idempotency record and an enqueue intent for the input in ONE
 * transaction, keyed by the Idempotency-Key. A retry finds the stored result and never loses or
 * doubles the input. Answers `202 { decisionId }`.
 */
export async function recordAndEnqueue(
  ctx: RouteContext,
  input: { runId: string | null; decision: DecisionSpec; message: WorkMessage; extra?: Op[] },
): Promise<ApiResponse> {
  const prior = await storedResult(ctx.deps, ctx.operator.id, ctx.idempotencyKey);
  if (prior) return prior;
  const now = ctx.deps.clock.now().toISOString();
  const decisionId = newId("dec");
  const key = `api:${ctx.operator.id}:${ctx.idempotencyKey ?? decisionId}`;
  const owner = input.message.group.startsWith("run:") ? `RUN#${input.message.group.slice(4)}` : `API#${ctx.operator.id}`;
  const res: ApiResponse = { status: 202, body: { decisionId } };
  const ops: Op[] = [
    ...decisionOps(input.runId, [{ ...input.decision, detail: { ...input.decision.detail, decisionId } }], now),
    ...intentOps(owner, [enqueue(input.message, key)], now).ops,
    ...(input.extra ?? []),
  ];
  if (ctx.idempotencyKey) ops.push(storeResultOp(ctx.deps, ctx.operator.id, ctx.idempotencyKey, res));
  try {
    await ctx.deps.table.transact(ops);
  } catch (e) {
    if (e instanceof ConditionFailed && ctx.idempotencyKey) {
      const again = await storedResult(ctx.deps, ctx.operator.id, ctx.idempotencyKey);
      if (again) return again;
    }
    throw e;
  }
  return res;
}
