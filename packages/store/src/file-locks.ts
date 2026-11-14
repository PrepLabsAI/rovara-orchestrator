import type { DagNode } from "@rovara-orch/core";
import { keys } from "./keys.js";
import type { Op, Table } from "./table.js";

const locked = (files: readonly string[]) => files.filter((f) => !f.endsWith("/"));

/** Files held by running nodes on a repository, across every run: `REPO#<repo>` / `FILE#<path>`. */
export async function heldFiles(table: Table, repo: string): Promise<Map<string, { runId: string; nodeId: string }>> {
  const p = keys.repoFilesPrefix(repo);
  const items = await table.query<{ sk: string; runId: string; nodeId: string }>(p.pk, p.skPrefix);
  return new Map(items.map((i) => [i.sk.slice("FILE#".length), { runId: i.runId, nodeId: i.nodeId }]));
}

/**
 * Lock writes for a node being started, in the start's transaction (FR-022). Each succeeds only if
 * the file is free or already this node's (from an earlier attempt), so two passes racing for one
 * file cannot both start.
 */
export function lockOps(repo: string, runId: string, node: DagNode): Op[] {
  return locked(node.files).map((path) => ({
    kind: "put" as const,
    item: { ...keys.repoFile(repo, path), entityType: "FILE_LOCK", runId, nodeId: node.nodeId },
    condition: {
      expression: "attribute_not_exists(pk) OR (#r = :r AND #n = :n)",
      names: { "#r": "runId", "#n": "nodeId" },
      values: { ":r": runId, ":n": node.nodeId },
    },
  }));
}

/**
 * Lock removals when a node merges, is skipped or is cancelled: only the locks this node holds, so a
 * node that never started never frees another node's file.
 */
export async function unlockOps(table: Table, repo: string, runId: string, nodeIds: readonly string[]): Promise<Op[]> {
  if (!nodeIds.length) return [];
  const mine = new Set(nodeIds);
  const ops: Op[] = [];
  for (const [path, holder] of await heldFiles(table, repo)) {
    if (holder.runId === runId && mine.has(holder.nodeId)) ops.push({ kind: "delete", key: keys.repoFile(repo, path) });
  }
  return ops;
}
