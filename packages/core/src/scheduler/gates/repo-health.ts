import type { Gate } from "../types.js";

/** FR-044: while main is red, nothing starts on the repository. */
export const repoHealthGate: Gate = (snapshot, candidates) => {
  if (!snapshot.repo.paused) return { pass: candidates, hold: [] };
  const checks = snapshot.repo.failingChecks.join(", ") || "its required checks";
  return { pass: [], hold: candidates.map((candidate) => ({ candidate, waitingFor: { reason: "main_red" as const, detail: `main is failing ${checks}` } })) };
};
