import type { Gate, Hold } from "../types.js";

/** Listed files that lock: paths ending in `/` name folders and are not locked. */
export const lockedFiles = (files: readonly string[]): string[] => files.filter((f) => !f.endsWith("/"));

/**
 * FR-022: across every run on the repository, no two running nodes share a listed file. A file is
 * taken if a running node holds its lock, or an earlier candidate in this pass claimed it. A node's
 * own lock (kept from an earlier attempt) does not hold it.
 */
export const fileLocksGate: Gate = (snapshot, candidates) => {
  const claimed = new Map<string, string>();
  const pass = [];
  const hold: Hold[] = [];
  for (const c of candidates) {
    const taken: string[] = [];
    for (const f of lockedFiles(c.dagNode.files)) {
      const held = snapshot.heldFiles.get(f);
      if (held && !(held.runId === c.run.runId && held.nodeId === c.node.nodeId)) taken.push(`${f} (held by ${held.nodeId})`);
      else if (claimed.has(f)) taken.push(`${f} (held by ${claimed.get(f)})`);
    }
    if (taken.length) {
      hold.push({ candidate: c, waitingFor: { reason: "files", detail: taken.join(", ") } });
      continue;
    }
    for (const f of lockedFiles(c.dagNode.files)) claimed.set(f, c.node.nodeId);
    pass.push(c);
  }
  return { pass, hold };
};
