import { enqueueMany, type QueueMessage, type Settings } from "@rovara-orch/core";
import { decisionOps, intentOps, keys, settingsFields, versionedWrite, withFreshRead, type Op, type Repositories, type Table } from "@rovara-orch/store";
import { ApiError } from "../errors.js";
import type { Route } from "../types.js";
import { requireReason } from "./runs-control.js";

/** Attempts the stop switch may have held: a plan approval (running) or a merge (open PR). */
async function heldAttempts(repos: Repositories): Promise<string[]> {
  const out: string[] = [];
  for (const run of await repos.listActiveRuns()) {
    for (const n of await repos.getRunNodes(run.runId)) {
      if (!n.currentAttempt) continue;
      if (n.state === "pr_open") out.push(n.currentAttempt);
      else if (n.state === "running" && (await repos.getAttempt(n.currentAttempt))?.plan?.held) out.push(n.currentAttempt);
    }
  }
  return out;
}

/**
 * Turn the stop switch on or off (FR-051). Turning it off writes, in the same transaction as the
 * setting, one enqueue intent releasing every held plan approval.
 */
export async function setStopSwitch(
  deps: { table: Table; repos: Repositories; clock: { now(): Date } },
  operatorId: string,
  on: boolean,
  reason: string,
): Promise<Settings["stopSwitch"]> {
  return withFreshRead(async () => {
    const settings = await deps.repos.getSettings();
    const now = deps.clock.now().toISOString();
    const stopSwitch = { on, by: operatorId, at: now, reason };
    const next: Settings = { ...settings, stopSwitch };
    const ops: Op[] = [
      versionedWrite(keys.settings(), settingsFields(next), settings.version),
      ...decisionOps(null, [{ actor: operatorId, action: "stop_switch", reason, detail: { on } }], now),
    ];
    if (!on && settings.stopSwitch.on) {
      const decisionKey = `${now}:${operatorId}`;
      const messages: QueueMessage[] = (await heldAttempts(deps.repos)).map((attemptId) => ({
        group: `att:${attemptId}`,
        input: { kind: "control", action: "release", by: operatorId, reason },
        inputId: `release:${attemptId}:${decisionKey}`,
      }));
      if (messages.length) ops.push(...intentOps("SETTINGS", [enqueueMany(messages, `release:${decisionKey}`)], now).ops);
    }
    await deps.table.transact(ops);
    return stopSwitch;
  });
}

export const routes: Route[] = [
  {
    method: "GET",
    pattern: "/v1/stop-switch",
    handler: async ({ deps }) => ({ status: 200, body: (await deps.repos.getSettings()).stopSwitch }),
  },
  {
    method: "PUT",
    pattern: "/v1/stop-switch",
    handler: async ({ deps, req, operator }) => {
      const on = (req.body as { on?: unknown } | undefined)?.on;
      if (typeof on !== "boolean") throw new ApiError("INVALID", "on must be true or false", { problem: "on" });
      return { status: 200, body: await setStopSwitch(deps, operator.id, on, requireReason(req.body)) };
    },
  },
];
