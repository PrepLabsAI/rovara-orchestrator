import type { DagNode, NodeRunState, NodeState, Repository, Run, Settings, WaitingFor } from "../model.js";

export interface Candidate {
  run: Run;
  dagNode: DagNode;
  node: NodeRunState;
}

/** Everything a scheduling pass for one repository needs, read in one go. */
export interface Snapshot {
  now: string;
  settings: Settings;
  repo: Repository;
  /** Every non-final node of every running or paused run on the repository. */
  candidates: Candidate[];
  /** States of every node in those runs, keyed `${runId}/${nodeId}`, for dependency checks. */
  nodeStates: Map<string, NodeState>;
  /** Nodes currently holding a workspace, per run. */
  activeByRun: Map<string, number>;
  /** Files held by running nodes in any run on the repository. */
  heldFiles: Map<string, { runId: string; nodeId: string }>;
}

export interface Hold {
  candidate: Candidate;
  waitingFor: WaitingFor;
}

/** A gate passes some candidates on and holds the rest with a reason. Gates run in a fixed order. */
export type Gate = (snapshot: Snapshot, candidates: Candidate[]) => { pass: Candidate[]; hold: Hold[] };

export interface PickResult {
  starts: Candidate[];
  holds: Hold[];
}

export const passThrough: Gate = (_s, candidates) => ({ pass: candidates, hold: [] });
