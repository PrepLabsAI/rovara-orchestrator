import type { DagNode } from "@rovara-orch/core";
import { keys } from "./keys.js";
import type { Op, Table } from "./table.js";

/** Files held by running nodes on a repository. Stub until US4 writes lock items. */
export async function heldFiles(table: Table, repo: string): Promise<Map<string, { runId: string; nodeId: string }>> {
  const p = keys.repoFilesPrefix(repo);
  const items = await table.query<{ sk: string; runId: string; nodeId: string }>(p.pk, p.skPrefix);
  return new Map(items.map((i) => [i.sk.slice("FILE#".length), { runId: i.runId, nodeId: i.nodeId }]));
}

/** Lock writes for a node being started, in the start's transaction. Stub until US4. */
export function lockOps(_repo: string, _runId: string, _node: DagNode): Op[] {
  return [];
}

/** Lock removals when a node merges, is skipped or is cancelled. Stub until US4. */
export function unlockOps(_repo: string, _node: DagNode): Op[] {
  return [];
}
