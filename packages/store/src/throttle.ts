import { minuteOf, RATE_WINDOW_MINUTES } from "@rovara-orch/core";
import type { Op, Table } from "./table.js";

/**
 * Per-repository, per-minute counters for back-off (FR-063): starts made, start requests sent to
 * Rovara, and requests Rovara refused for throttling. Atomic ADD, outside any version check; each
 * item expires after a day.
 */
const key = (repo: string, minute: number) => ({ pk: `RATE#${repo}`, sk: String(minute).padStart(10, "0") });

export interface MinuteCounts {
  started: number;
  requests: number;
  throttled: number;
}

export function countOp(repo: string, at: Date | string, add: Partial<MinuteCounts>): Op {
  const minute = minuteOf(at);
  return { kind: "update", key: key(repo, minute), add: Object.fromEntries(Object.entries(add).filter(([, v]) => v)) as Record<string, number>, set: { entityType: "RATE", expiresAt: minute * 60 + 24 * 3600 } };
}

/** Counts for the minutes [from, to] inclusive. */
export async function readMinutes(table: Table, repo: string, from: number, to: number): Promise<MinuteCounts> {
  const items = await table.query<MinuteCounts & { sk: string }>(`RATE#${repo}`, "", { after: String(from - 1).padStart(10, "0") });
  const sum: MinuteCounts = { started: 0, requests: 0, throttled: 0 };
  for (const i of items) {
    if (Number(i.sk) > to) break;
    sum.started += i.started ?? 0;
    sum.requests += i.requests ?? 0;
    sum.throttled += i.throttled ?? 0;
  }
  return sum;
}

/** The minutes of back-off window `w`. */
export const windowMinutes = (w: number): [number, number] => [w * RATE_WINDOW_MINUTES, w * RATE_WINDOW_MINUTES + RATE_WINDOW_MINUTES - 1];
