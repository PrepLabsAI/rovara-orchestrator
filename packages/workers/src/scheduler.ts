import {
  ACTIVE_NODE_STATES,
  addMinutes,
  attemptIdOf,
  attemptThread,
  enqueue,
  FINAL_NODE_STATES,
  moveNode,
  minuteOf,
  pick,
  type Attempt,
  type Candidate,
  type Hold,
  type Intent,
  type NodeState,
  type Snapshot,
} from "@rovara-orch/core";
import {
  acquireLease,
  ConditionFailed,
  counterOp,
  encodeAttempt,
  countOp,
  heldFiles,
  intentOps,
  readMinutes,
  keys,
  lockOps,
  nodeFields,
  releaseLease,
  type Op,
} from "@rovara-orch/store";
import type { Deps } from "./ports.js";

/** Read everything one pass over a repository needs. */
export async function loadSnapshot(deps: Deps, repoName: string): Promise<Snapshot> {
  const minute = minuteOf(deps.clock.now());
  const [runs, settings, repo, held, thisMinute] = await Promise.all([
    deps.repos.listActiveRuns(repoName),
    deps.repos.getSettings(),
    deps.repos.getRepo(repoName),
    heldFiles(deps.table, repoName),
    readMinutes(deps.table, repoName, minute, minute),
  ]);
  const candidates: Candidate[] = [];
  const nodeStates = new Map<string, NodeState>();
  const activeByRun = new Map<string, number>();
  for (const run of runs) {
    const [nodes, dagNodes] = await Promise.all([deps.repos.getRunNodes(run.runId), deps.repos.getDagNodes(run.dagId)]);
    const byId = new Map(dagNodes.map((n) => [n.nodeId, n]));
    let active = 0;
    for (const node of nodes) {
      nodeStates.set(`${run.runId}/${node.nodeId}`, node.state);
      if (ACTIVE_NODE_STATES.includes(node.state)) active++;
      const dagNode = byId.get(node.nodeId);
      if (dagNode && !FINAL_NODE_STATES.includes(node.state)) candidates.push({ run, dagNode, node });
    }
    activeByRun.set(run.runId, active);
  }
  return { now: deps.clock.now().toISOString(), settings, repo, candidates, nodeStates, activeByRun, heldFiles: held, startedThisMinute: thisMinute.started };
}

function newAttempt(deps: Deps, c: Candidate, baseCommit: string | null, now: string): Attempt {
  const n = c.node.attempts + 1;
  const thread = attemptThread(c.run.runId, c.node.nodeId, n);
  return {
    attemptId: attemptIdOf(thread),
    runId: c.run.runId,
    nodeId: c.node.nodeId,
    n,
    conversation: { channel: deps.config.channel, tenant: deps.config.rovaraTenant, space: deps.config.rovaraSpace, thread },
    baseCommit,
    phase: "starting",
    plan: null,
    checkReports: [],
    fixRequests: 0,
    pullRequests: [],
    rovaraTaskIds: [],
    rovaraTaskUrl: null,
    outcome: null,
    outcomeReason: null,
    due: { quietAt: addMinutes(now, c.run.retry.quietMinutes), reviewAt: null, retryAt: null },
    review: { headSha: null, reviewedAt: null, rerequestedAt: null, unresolved: 0, sent: [] },
    ci: { headSha: null, pr: "pending", queue: "none", failing: [] },
    costUsd: 0,
    startedAt: now,
    endedAt: null,
    version: 1,
  };
}

/** One transaction per start: the attempt, the node's move to running, its file locks, and the start input. */
function startOps(c: Candidate, attempt: Attempt, now: string): { ops: Op[]; intents: Intent[] } {
  const { node, counters } = moveNode(c.node, "running", {
    currentAttempt: attempt.attemptId,
    attempts: attempt.n,
    waitingFor: null,
  });
  const start = enqueue({ group: `att:${attempt.attemptId}`, input: { kind: "start" } }, `start:${attempt.attemptId}`);
  const { ops: iops, intents } = intentOps(`ATT#${attempt.attemptId}`, [start], now);
  const ops: Op[] = [
    { kind: "put", item: encodeAttempt(attempt), ifNotExists: true },
    { kind: "update", key: keys.runNode(node.runId, node.nodeId), set: nodeFields(node), expectedVersion: c.node.version },
    ...lockOps(c.run.repo, c.run.runId, c.dagNode),
    ...iops,
    countOp(c.run.repo, now, { started: 1 }),
  ];
  const counter = counterOp(c.run.runId, counters);
  if (counter) ops.push(counter);
  return { ops, intents };
}

/** Record why a node is waiting: `waiting` while dependencies are unmerged, `eligible` otherwise. */
function holdOps(h: Hold): Op[] {
  const to: NodeState = h.waitingFor.reason === "dependencies" ? "waiting" : "eligible";
  const same =
    h.candidate.node.state === to &&
    h.candidate.node.waitingFor?.reason === h.waitingFor.reason &&
    h.candidate.node.waitingFor?.detail === h.waitingFor.detail;
  if (same) return [];
  const { node, counters } = moveNode(h.candidate.node, to, { waitingFor: h.waitingFor });
  const ops: Op[] = [
    { kind: "update", key: keys.runNode(node.runId, node.nodeId), set: nodeFields(node), expectedVersion: h.candidate.node.version },
  ];
  const counter = counterOp(node.runId, counters);
  if (counter) ops.push(counter);
  return ops;
}

/**
 * One scheduling pass over a repository, under its lease: pick the nodes to start and start each
 * in its own transaction. A start that loses a race is skipped; the next pass reconsiders it.
 */
export async function runSchedulerPass(deps: Deps, repoName: string): Promise<Intent[]> {
  const owner = `pass-${Math.random().toString(36).slice(2)}`;
  if (!(await acquireLease(deps.table, repoName, owner, deps.clock.now()))) return [];
  const written: Intent[] = [];
  try {
    const snapshot = await loadSnapshot(deps, repoName);
    const { starts, holds } = pick(snapshot);
    const baseCommit = starts.length ? await deps.github.mainHead(repoName) : null;
    for (const c of starts) {
      const attempt = newAttempt(deps, c, baseCommit, snapshot.now);
      const { ops, intents } = startOps(c, attempt, snapshot.now);
      try {
        await deps.table.transact(ops);
        written.push(...intents);
      } catch (e) {
        if (!(e instanceof ConditionFailed)) throw e;
        deps.log?.({ event: "scheduler.start_lost_race", nodeId: c.node.nodeId });
      }
    }
    for (const h of holds) {
      const ops = holdOps(h);
      if (!ops.length) continue;
      await deps.table.transact(ops).catch((e: unknown) => {
        if (!(e instanceof ConditionFailed)) throw e;
      });
    }
  } finally {
    await releaseLease(deps.table, repoName, owner);
  }
  return written;
}
