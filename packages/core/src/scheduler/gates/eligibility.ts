import type { Gate, Hold } from "../types.js";

/**
 * FR-011 to FR-013: a node is eligible when every node it depends on is merged or skipped. Nodes
 * done at import were stored as merged, so they count without special cases.
 */
export const eligibilityGate: Gate = (snapshot, candidates) => {
  const pass = [];
  const hold: Hold[] = [];
  for (const c of candidates) {
    const pending = c.dagNode.dependsOn.filter((dep) => {
      const s = snapshot.nodeStates.get(`${c.run.runId}/${dep}`);
      return s !== "merged" && s !== "skipped";
    });
    if (pending.length) hold.push({ candidate: c, waitingFor: { reason: "dependencies", detail: pending.join(", ") } });
    else pass.push(c);
  }
  return { pass, hold };
};
