import type { NodeRunState } from "../model.js";
import type { RunHandler } from "./types.js";

/** A run is done when every node is merged or skipped. */
export function isRunDone(nodes: NodeRunState[]): boolean {
  return nodes.length > 0 && nodes.every((n) => n.state === "merged" || n.state === "skipped");
}

/**
 * Run accounting. Node counts and cost are counter changes (atomic ADD, outside the version check)
 * made by the transitions that change nodes or record costs; this handler completes the run once
 * every node is merged or skipped, and releases the DAG's active-run slot.
 */
export const runAccounting: RunHandler = (ctx, input) => {
  if (input.kind !== "node_finished") return undefined;
  if (ctx.run.state !== "running" && ctx.run.state !== "paused") return undefined;
  if (!isRunDone(ctx.nodes)) return undefined;
  return {
    run: { ...ctx.run, state: "complete", endedAt: ctx.now, pausedFor: null },
    intents: [],
    decisions: [],
    records: [{ kind: "delete", key: { pk: `DAGRUN#${ctx.run.dagId}`, sk: "ACTIVE" } }],
  };
};
