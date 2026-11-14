import { keys } from "./keys.js";
import type { Op, Table } from "./table.js";

/** Rovara payloads are stored as sent, up to 64 KB (FR-055). */
export const MAX_TRACE_PAYLOAD_BYTES = 64 * 1024;
export const TRACE_RETENTION_DAYS = 90;

export interface TraceStep {
  sequence: number;
  at: string;
  kind: string;
  payload: unknown;
}

const counterKey = (attemptId: string) => ({ pk: `TRACECOUNT#${attemptId}`, sk: "META" });

function capped(payload: unknown): unknown {
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json) <= MAX_TRACE_PAYLOAD_BYTES) return payload;
  return { truncated: true, text: json.slice(0, MAX_TRACE_PAYLOAD_BYTES - 1024) };
}

/**
 * The writes for one trace step, numbered in arrival order: the next number after the attempt's
 * counter. The step is written with `attribute_not_exists(sk)` and the counter is moved on only if
 * it is unchanged, so two events racing for one number cannot both commit (the loser is retried
 * by its sender). No TTL until the run ends.
 */
export async function traceStepOps(table: Table, attemptId: string, step: Omit<TraceStep, "sequence">): Promise<Op[]> {
  const counter = await table.get<{ last: number }>(counterKey(attemptId));
  const last = counter?.last ?? 0;
  const sequence = last + 1;
  return [
    { kind: "put", item: { ...keys.trace(attemptId, sequence), entityType: "TRACE", sequence, at: step.at, kind: step.kind, payload: capped(step.payload) }, condition: { expression: "attribute_not_exists(sk)" } },
    {
      kind: "put",
      item: { ...counterKey(attemptId), entityType: "TRACECOUNT", last: sequence },
      condition: counter ? { expression: "#l = :l", names: { "#l": "last" }, values: { ":l": last } } : { expression: "attribute_not_exists(pk)" },
    },
  ];
}

/** Steps after `after` (a sequence), oldest first, at most `limit`; `next` is set when more may follow. */
export async function readTrace(table: Table, attemptId: string, after: number | null, limit: number): Promise<{ steps: TraceStep[]; next: number | null }> {
  const { pk } = keys.tracePrefix(attemptId);
  const items = await table.query<TraceStep>(pk, "", { limit: limit + 1, ...(after !== null ? { after: String(after).padStart(12, "0") } : {}) });
  const steps = items.slice(0, limit).map((i) => ({ sequence: i.sequence, at: i.at, kind: i.kind, payload: i.payload }));
  return { steps, next: items.length > limit ? steps.at(-1)!.sequence : null };
}

/** Give every trace step of these attempts an expiry `endedAt` + 90 days (epoch seconds, for the table's TTL). */
export async function expireTrace(table: Table, attemptIds: readonly string[], endedAt: string): Promise<number> {
  const expiresAt = Math.floor(new Date(endedAt).getTime() / 1000) + TRACE_RETENTION_DAYS * 24 * 3600;
  let n = 0;
  for (const attemptId of attemptIds) {
    const steps = await table.query<{ pk: string; sk: string }>(keys.tracePrefix(attemptId).pk, "");
    for (let i = 0; i < steps.length; i += 25) {
      await table.transact(steps.slice(i, i + 25).map((s) => ({ kind: "update" as const, key: { pk: s.pk, sk: s.sk }, set: { expiresAt }, ifExists: true })));
    }
    n += steps.length;
  }
  return n;
}
