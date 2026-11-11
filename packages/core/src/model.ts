/**
 * Domain types, exactly as in specs/001-dag-orchestrator/data-model.md.
 * Pure data: no I/O, no AWS types.
 */

export const NODE_STATES = [
  "waiting",
  "eligible",
  "running",
  "checks_failed",
  "pr_open",
  "in_merge_queue",
  "merged",
  "escalated",
  "skipped",
  "cancelled",
] as const;
export type NodeState = (typeof NODE_STATES)[number];
/** States a node never leaves. */
export const FINAL_NODE_STATES: readonly NodeState[] = ["merged", "skipped", "cancelled"];
/** States in which a node holds a Rovara workspace (counts toward concurrency). */
export const ACTIVE_NODE_STATES: readonly NodeState[] = ["running", "checks_failed", "pr_open", "in_merge_queue"];

export const RUN_STATES = ["running", "paused", "complete", "cancelled"] as const;
export type RunState = (typeof RUN_STATES)[number];

export const ATTEMPT_PHASES = [
  "starting",
  "planning",
  "coding",
  "checked",
  "pr_requested",
  "pr_open",
  "reviewing",
  "queued",
  "merged",
  "failed",
  "abandoned",
  "cancelled",
] as const;
export type AttemptPhase = (typeof ATTEMPT_PHASES)[number];
export const FINAL_ATTEMPT_PHASES: readonly AttemptPhase[] = ["merged", "failed", "abandoned", "cancelled"];

export const INTENT_EFFECTS = [
  "rovara.message",
  "rovara.decision",
  "rovara.close",
  "rovara.cancel",
  "rovara.workspace_limit",
  "github.enqueue",
  "github.resolve_thread",
  "github.comment",
  "github.close_pr",
  "slack.post",
  "slack.reply",
  "model.answer",
  "queue.enqueue",
] as const;
export type IntentEffect = (typeof INTENT_EFFECTS)[number];

export interface RetryLimits {
  fixRequests: number;
  attempts: number;
  prUpdates: number;
  reviewRounds: number;
  quietMinutes: number;
}
export const DEFAULT_RETRY: RetryLimits = { fixRequests: 2, attempts: 3, prUpdates: 3, reviewRounds: 3, quietMinutes: 30 };

/** "1 to 5000" */
export const CONCURRENCY_MIN = 1;
export const CONCURRENCY_MAX = 5000;

export const WAITING_REASONS = ["dependencies", "files", "capacity", "paused", "main_red", "cost"] as const;
export type WaitingReason = (typeof WAITING_REASONS)[number];
export interface WaitingFor {
  reason: WaitingReason;
  detail?: string;
}

export interface TaskText {
  id: string;
  title: string;
  text: string;
  ref: string;
  files: string[];
}

/** One unit of work in a DAG, copied from the imported graph. */
export interface DagNode {
  dagId: string;
  nodeId: string;
  title: string;
  kind: string;
  priority: string | null;
  mvp: boolean;
  /** Repository-relative; entries ending in `/` are directories and are not locked. */
  files: string[];
  tasks: TaskText[];
  dependsOn: string[];
  doneAtImport: boolean;
  /** Order in the graph, for scheduling ties. */
  order: number;
}

export interface Dag {
  dagId: string;
  hash: string;
  repo: string;
  commit: string;
  specDir: string;
  docs: Record<string, string>;
  feature: string | null;
  unit: "story";
  nodeCount: number;
  edgeCount: number;
  importedAt: string;
  importedBy: string;
  /** S3 key when the imported file was over 300 KB. */
  sourceKey?: string;
}

export interface Run {
  runId: string;
  dagId: string;
  repo: string;
  state: RunState;
  concurrencyLimit: number;
  costLimitUsd: number;
  retry: RetryLimits;
  /** Updated with atomic ADD, outside the version check. */
  costUsd: number;
  /** Updated with atomic ADD, outside the version check. */
  counts: Partial<Record<NodeState, number>>;
  startedBy: string;
  actingFor: string;
  startedAt: string;
  endedAt: string | null;
  pausedFor: "operator" | "cost" | "lost_access" | null;
  tracesExpireSetAt: string | null;
  version: number;
}

export interface Escalation {
  at: string;
  reason: string;
  slackTs: string | null;
}

export interface NodeRunState {
  runId: string;
  nodeId: string;
  state: NodeState;
  waitingFor: WaitingFor | null;
  currentAttempt: string | null;
  attempts: number;
  prUpdates: number;
  reviewRounds: number;
  mergeCommit: string | null;
  escalation: Escalation | null;
  skippedBy: { operator: string; reason: string; at: string } | null;
  /** Dependencies that were skipped rather than merged, shown on the node page. */
  unblockedBySkip: string[];
  version: number;
}

export interface ConversationRef {
  channel: string;
  tenant: string;
  space: string;
  thread: string;
}

export interface PullRequestRef {
  number: number;
  url: string;
  headSha: string | null;
  state: "open" | "closed" | "merged";
  openedAt: string;
}

export interface CheckReportRecord {
  status: "passed" | "failed" | "unknown";
  at: string;
  text: string;
}

export interface Attempt {
  attemptId: string;
  runId: string;
  nodeId: string;
  n: number;
  conversation: ConversationRef;
  baseCommit: string | null;
  phase: AttemptPhase;
  plan: { requestId: string; revision: number; digest: string; approvedAt: string | null; held: boolean } | null;
  checkReports: CheckReportRecord[];
  fixRequests: number;
  pullRequests: PullRequestRef[];
  rovaraTaskIds: string[];
  rovaraTaskUrl: string | null;
  outcome: "merged" | "failed" | "abandoned" | "cancelled" | null;
  outcomeReason: string | null;
  due: { quietAt: string | null; reviewAt: string | null; retryAt: string | null };
  /** Review state of the current PR head. */
  review: { headSha: string | null; reviewedAt: string | null; rerequestedAt: string | null; unresolved: number };
  costUsd: number;
  startedAt: string;
  endedAt: string | null;
  version: number;
}

export interface Question {
  attemptId: string;
  eventId: string;
  question: string;
  choices: string[];
  answer: string;
  choice: string | null;
  answeredBy: string;
  tries: number;
  costUsd: number;
  at: string;
}

export interface ReviewComment {
  attemptId: string;
  prNumber: number;
  threadId: string;
  author: string;
  body: string;
  path: string | null;
  line: number | null;
  commit: string | null;
  url: string | null;
  round: number | null;
  resolution: "fixed" | "answered" | "resolved_by_tool" | null;
}

export type IntentStatus = "pending" | "done" | "failed";

export interface IntentSpec {
  effect: IntentEffect;
  /** Idempotency key sent to the far end. Unique per effect. */
  key: string;
  payload: Record<string, unknown>;
}

export interface Intent extends IntentSpec {
  pk: string;
  sk: string;
  /** Monotonic ULID; also the sort key suffix. */
  seq: string;
  status: IntentStatus;
  result: Record<string, unknown> | null;
  tries: number;
  nextTryAt: string;
  createdAt: string;
}

export const DECISION_ACTIONS = [
  "approve",
  "answer",
  "merge",
  "retry",
  "skip",
  "cancel",
  "escalate",
  "pause",
  "resume",
  "take_over",
  "stop_switch",
  "refused",
  "import",
  "start",
] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

export interface DecisionSpec {
  actor: string;
  action: DecisionAction;
  reason: string;
  nodeId?: string;
  attemptId?: string;
  detail?: Record<string, unknown>;
}

export interface DecisionRecord extends DecisionSpec {
  id: string;
  runId: string | null;
  at: string;
}

export interface Repository {
  repo: string;
  paused: boolean;
  pausedSince: string | null;
  mainCommit: string | null;
  failingChecks: string[];
  startRate: number | null;
  rovaraFreeWorkspaces: number | null;
  rovaraProjectLimit: number | null;
  notification: { slackTs: string } | null;
  version: number;
}

export interface Settings {
  stopSwitch: { on: boolean; by: string | null; at: string | null; reason: string | null };
  notificationChannel: string | null;
  reviewToolLogin: string;
  reRequestComment: string;
  modelId: string;
  version: number;
}

export const DEFAULT_SETTINGS: Omit<Settings, "version"> = {
  stopSwitch: { on: false, by: null, at: null, reason: null },
  notificationChannel: null,
  reviewToolLogin: "coderabbitai[bot]",
  reRequestComment: "@coderabbitai review",
  modelId: "anthropic.claude-opus-5-5",
};

export function emptyRepository(repo: string): Repository {
  return {
    repo,
    paused: false,
    pausedSince: null,
    mainCommit: null,
    failingChecks: [],
    startRate: null,
    rovaraFreeWorkspaces: null,
    rovaraProjectLimit: null,
    notification: null,
    version: 0,
  };
}
