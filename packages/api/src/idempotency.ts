import { keys, type Op } from "@rovara-orch/store";
import type { ApiDeps, ApiResponse } from "./types.js";

export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

export const idempotencyKey = (operatorId: string, key: string) => keys.idempotency(operatorId, key);

/** The stored first result for this operator and key, if the request was already handled. */
export async function storedResult(deps: Pick<ApiDeps, "table">, operatorId: string, key: string | undefined): Promise<ApiResponse | undefined> {
  if (!key) return undefined;
  const item = await deps.table.get<{ status: number; body: unknown }>(idempotencyKey(operatorId, key));
  return item ? { status: item.status, body: item.body } : undefined;
}

/** The op that stores a result for 24 hours; written in the same transaction as the request's effects. */
export function storeResultOp(deps: Pick<ApiDeps, "clock">, operatorId: string, key: string, res: ApiResponse): Op {
  const expiresAt = Math.floor(deps.clock.now().getTime() / 1000) + IDEMPOTENCY_TTL_SECONDS;
  return { kind: "put", item: { ...idempotencyKey(operatorId, key), entityType: "IDEMPOTENCY", status: res.status, body: res.body, expiresAt }, ifNotExists: true };
}
