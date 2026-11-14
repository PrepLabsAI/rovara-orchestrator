import { WORKSPACE_LIMIT_HOLD_MS } from "../backoff.js";
import type { Repository, WaitingFor } from "../model.js";
import type { Candidate, Gate, Hold, PickResult, Snapshot } from "./types.js";
import { controlsGate } from "./gates/controls.js";
import { eligibilityGate } from "./gates/eligibility.js";
import { fileLocksGate } from "./gates/file-locks.js";
import { repoHealthGate } from "./gates/repo-health.js";
import { throttleGate } from "./gates/throttle.js";

/** Fixed gate order. */
export const GATES: ReadonlyArray<[string, Gate]> = [
  ["controls", controlsGate],
  ["repo-health", repoHealthGate],
  ["eligibility", eligibilityGate],
  ["file-locks", fileLocksGate],
  ["throttle", throttleGate],
];

const priorityRank = (p: string | null): number => {
  const m = p ? /^P(\d+)$/i.exec(p) : null;
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
};

/** MVP first, then priority (P1 before P2), then DAG order; run start time breaks ties across runs. */
export function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    Number(b.dagNode.mvp) - Number(a.dagNode.mvp) ||
    priorityRank(a.dagNode.priority) - priorityRank(b.dagNode.priority) ||
    a.run.startedAt.localeCompare(b.run.startedAt) ||
    a.dagNode.order - b.dagNode.order
  );
}

/**
 * Choose the nodes to start in one pass over one repository.
 * Only nodes in `waiting` or `eligible` are considered. Gates may hold nodes with a reason;
 * what passes is cut to capacity: per run, the concurrency limit minus nodes already active;
 * overall, Rovara's free workspaces when known.
 */
export function pick(snapshot: Snapshot): PickResult {
  let current = snapshot.candidates
    .filter((c) => c.node.state === "waiting" || c.node.state === "eligible")
    .filter((c) => c.run.state === "running" || c.run.state === "paused")
    .sort(compareCandidates);
  const holds: Hold[] = [];
  for (const [, gate] of GATES) {
    const r = gate(snapshot, current);
    current = r.pass;
    holds.push(...r.hold);
  }

  const starts: Candidate[] = [];
  const usedByRun = new Map(snapshot.activeByRun);
  let free = freeWorkspaces(snapshot.repo, snapshot.now);
  const noWorkspace = noWorkspaceReason(snapshot.repo);
  for (const c of current) {
    const used = usedByRun.get(c.run.runId) ?? 0;
    if (free !== null && free <= 0) {
      holds.push({ candidate: c, waitingFor: noWorkspace });
      continue;
    }
    if (used >= c.run.concurrencyLimit) {
      holds.push({ candidate: c, waitingFor: { reason: "capacity" } });
      continue;
    }
    starts.push(c);
    usedByRun.set(c.run.runId, used + 1);
    if (free !== null) free -= 1;
  }
  return { starts, holds };
}

/**
 * Rovara's free workspaces, as far as the orchestrator knows: none for a minute after Rovara refused
 * a start for its workspace limit (FR-062), then what was last known (null when unknown, until
 * Rovara offers a state read, Rovara#437/#440).
 */
export function freeWorkspaces(repo: Repository, now: string): number | null {
  if (repo.workspaceLimitAt && Date.parse(now) - Date.parse(repo.workspaceLimitAt) < WORKSPACE_LIMIT_HOLD_MS) return 0;
  if (repo.workspaceLimitAt && repo.rovaraFreeWorkspaces === 0) return null;
  return repo.rovaraFreeWorkspaces;
}

function noWorkspaceReason(repo: Repository): WaitingFor {
  if (repo.rovaraProjectLimit !== null) return { reason: "capacity", detail: `Rovara's project limit is ${repo.rovaraProjectLimit}; an administrator can raise it` };
  return { reason: "capacity", detail: "Rovara's workspace limit is reached" };
}

