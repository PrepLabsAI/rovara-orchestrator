import { DEFAULT_RETRY, type Attempt, type Dag, type DagNode, type NodeRunState, type Run } from "../model.js";

/** Small builders for tests across packages. */
export function aRun(p: Partial<Run> = {}): Run {
  return {
    runId: "run_01TEST000000000000000000000",
    dagId: "dag_1",
    repo: "acme/mono",
    state: "running",
    concurrencyLimit: 10,
    costLimitUsd: 100,
    retry: { ...DEFAULT_RETRY },
    costUsd: 0,
    counts: {},
    startedBy: "op_1",
    actingFor: "op_1",
    startedAt: "2026-11-11T00:00:00.000Z",
    endedAt: null,
    pausedFor: null,
    tracesExpireSetAt: null,
    version: 1,
    ...p,
  };
}

export function aNode(p: Partial<NodeRunState> = {}): NodeRunState {
  return {
    runId: "run_01TEST000000000000000000000",
    nodeId: "US1",
    state: "waiting",
    waitingFor: null,
    currentAttempt: null,
    attempts: 0,
    prUpdates: 0,
    reviewRounds: 0,
    mergeCommit: null,
    escalation: null,
    skippedBy: null,
    unblockedBySkip: [],
    version: 1,
    ...p,
  };
}

export function anAttempt(p: Partial<Attempt> = {}): Attempt {
  const runId = p.runId ?? "run_01TEST000000000000000000000";
  const nodeId = p.nodeId ?? "US1";
  const n = p.n ?? 1;
  const thread = `${runId}.${nodeId}.a${n}`;
  return {
    attemptId: `att_${thread}`,
    runId,
    nodeId,
    n,
    conversation: { channel: "orchestrator", tenant: "test", space: "mono", thread },
    baseCommit: null,
    phase: "starting",
    plan: null,
    checkReports: [],
    fixRequests: 0,
    pullRequests: [],
    rovaraTaskIds: [],
    rovaraTaskUrl: null,
    outcome: null,
    outcomeReason: null,
    due: { quietAt: null, reviewAt: null, retryAt: null },
    review: { headSha: null, reviewedAt: null, rerequestedAt: null, unresolved: 0, sent: [] },
    ci: { headSha: null, pr: "pending", queue: "none", failing: [] },
    costUsd: 0,
    startedAt: "2026-11-11T00:00:00.000Z",
    endedAt: null,
    version: 1,
    ...p,
  };
}

export function aDag(p: Partial<Dag> = {}): Dag {
  return {
    dagId: "dag_1",
    hash: "sha256:" + "a".repeat(64),
    repo: "acme/mono",
    commit: "c".repeat(40),
    specDir: "specs/001-x",
    docs: { spec: "specs/001-x/spec.md" },
    feature: "X",
    unit: "story",
    nodeCount: 1,
    edgeCount: 0,
    importedAt: "2026-11-11T00:00:00.000Z",
    importedBy: "op_1",
    ...p,
  };
}

export function aDagNode(p: Partial<DagNode> = {}): DagNode {
  return {
    dagId: "dag_1",
    nodeId: "US1",
    title: "User Story 1",
    kind: "story",
    priority: "P1",
    mvp: false,
    files: [],
    tasks: [{ id: "T001", title: "Do it", text: "- [ ] T001 Do it in src/a.ts", ref: "specs/001-x/tasks.md#T001", files: ["src/a.ts"] }],
    dependsOn: [],
    doneAtImport: false,
    order: 0,
    ...p,
  };
}

import { DEFAULT_SETTINGS, emptyRepository, type Settings } from "../model.js";
import type { AttemptContext, RunContext } from "../machine/types.js";

export function aSettings(p: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, notificationChannel: "C-NOTIFY", ...p, version: 1 };
}

/** A context for the attempt machine: one run, one node, one attempt. */
export function anAttemptContext(p: Partial<AttemptContext> = {}): AttemptContext {
  const run = p.run ?? aRun();
  const node = p.node ?? aNode({ runId: run.runId, state: "running", currentAttempt: "x" });
  const attempt = p.attempt ?? anAttempt({ runId: run.runId, nodeId: node.nodeId });
  return {
    now: "2026-11-11T01:00:00.000Z",
    run,
    node: { ...node, currentAttempt: node.currentAttempt === "x" ? attempt.attemptId : node.currentAttempt },
    attempt,
    dag: aDag({ dagId: run.dagId }),
    dagNode: aDagNode({ dagId: run.dagId, nodeId: node.nodeId }),
    repo: emptyRepository(run.repo),
    settings: aSettings(),
    ...p,
  };
}

export function aRunContext(p: Partial<RunContext> = {}): RunContext {
  const run = p.run ?? aRun();
  return {
    now: "2026-11-11T01:00:00.000Z",
    run,
    dag: aDag({ dagId: run.dagId }),
    nodes: [],
    dagNodes: [],
    repo: emptyRepository(run.repo),
    settings: aSettings(),
    actingForIsAdmin: false,
    ...p,
  };
}
