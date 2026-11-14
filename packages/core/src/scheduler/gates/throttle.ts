import type { Gate, Hold } from "../types.js";

/** FR-063: while Rovara is throttling, at most `startRate` starts a minute on the repository. */
export const throttleGate: Gate = (snapshot, candidates) => {
  const rate = snapshot.repo.startRate;
  if (rate === null) return { pass: candidates, hold: [] };
  const budget = Math.max(0, rate - snapshot.startedThisMinute);
  const waitingFor = { reason: "capacity" as const, detail: `Rovara is throttling starts: at most ${rate} a minute for now` };
  const hold: Hold[] = candidates.slice(budget).map((candidate) => ({ candidate, waitingFor }));
  return { pass: candidates.slice(0, budget), hold };
};
