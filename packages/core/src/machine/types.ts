/**
 * The pure transition contract shared by the attempt, run and repository machines.
 * A machine takes its context and one input, and returns what to write, or undefined when the
 * input changes nothing. It never performs I/O: every outside effect is an IntentSpec.
 */
import type {
  Attempt,
  Dag,
  DagNode,
  DecisionSpec,
  IntentSpec,
  NodeRunState,
  NodeState,
  Repository,
  Run,
  Settings,
} from "../model.js";

// ---------- Inputs ----------

export type RovaraEventType =
  | "ack"
  | "message"
  | "progress"
  | "question"
  | "approval_request"
  | "check_report"
  | "pr"
  | "done"
  | "error"
  | "link_required";

/** A verified Rovara callback event for one attempt (shape follows Rovara spec 062, FR-022). */
export interface RovaraInput {
  kind: "rovara";
  eventId: string;
  type: RovaraEventType;
  createdAt: string;
  data: Record<string, unknown>;
}

export interface ReviewThreadInput {
  threadId: string;
  author: string;
  body: string;
  path: string | null;
  line: number | null;
  commit: string | null;
  url: string | null;
  resolved: boolean;
  /** Rovara replied on the thread with a reason, or pushed a commit after it. */
  addressed: "fixed" | "answered" | null;
}

export type GithubAttemptEvent =
  | { type: "pr_opened" | "pr_synchronize"; number: number; headSha: string; baseRef: string; repo: string; changedFiles: number }
  | { type: "pr_closed"; number: number; merged: boolean; mergeCommit: string | null }
  | { type: "merged_on_main"; number: number; mergeCommit: string }
  | {
      type: "review_state";
      number: number;
      headSha: string;
      /** The review tool has reviewed this head commit. */
      reviewed: boolean;
      threads: ReviewThreadInput[];
    }
  | {
      type: "checks";
      number: number;
      headSha: string;
      scope: "pr" | "merge_queue";
      status: "passed" | "failed" | "pending";
      failing: string[];
    }
  | {
      type: "merge_group";
      number: number;
      status: "entered" | "removed";
      reason: "conflict" | "out_of_date" | "failed_checks" | "other" | null;
    }
  | { type: "conflict"; number: number; headSha: string };

export interface GithubInput {
  kind: "github";
  deliveryId: string;
  event: GithubAttemptEvent;
}

export interface TimerInput {
  kind: "timer";
  timer: "quiet" | "review" | "retry";
  at: string;
}

/** Inputs the run machine sends to one attempt. */
export interface ControlInput {
  kind: "control";
  action: "cancel" | "release";
  by: string;
  reason: string;
}

/** Sent by the scheduler right after it created the attempt. */
export interface StartInput {
  kind: "start";
}

/** Sent by the model executor once an answer has been sent. */
export interface AnsweredInput {
  kind: "answered";
  eventId: string;
  costUsd: number;
}

/** An effect the intent runner gave up on. */
export interface IntentFailedInput {
  kind: "intent_failed";
  effect: string;
  key: string;
  error: string;
}

export type AttemptInput =
  | RovaraInput
  | GithubInput
  | TimerInput
  | ControlInput
  | StartInput
  | AnsweredInput
  | IntentFailedInput;

export type RunInput =
  | { kind: "run_start" }
  | { kind: "pause" | "resume" | "cancel" | "take_over"; by: string; reason: string; decisionId: string }
  | { kind: "cost_limit" }
  | { kind: "lost_access"; operator: string }
  | { kind: "node_finished"; nodeId: string; state: NodeState };

export type RepoInput =
  | { kind: "main_checks"; headSha: string; status: "passed" | "failed" | "pending"; failing: string[]; confirmed: boolean }
  | { kind: "schedule" }
  /** Read a PR's state from GitHub and turn it into inputs for its attempt (constitution III). */
  | { kind: "reconcile_pr"; attemptId: string };

/** A queue message: one input for one group. */
export type WorkMessage =
  | { group: `att:${string}`; input: AttemptInput }
  | { group: `run:${string}`; input: RunInput }
  | { group: `repo:${string}`; input: RepoInput };

// ---------- Contexts ----------

export interface AttemptContext {
  now: string;
  attempt: Attempt;
  node: NodeRunState;
  run: Run;
  dag: Dag;
  dagNode: DagNode;
  repo: Repository;
  settings: Settings;
}

export interface RunContext {
  now: string;
  run: Run;
  dag: Dag;
  nodes: NodeRunState[];
  dagNodes: DagNode[];
  repo: Repository;
  settings: Settings;
  /** Whether the run's acting-for operator is a Rovara administrator (run-start capacity check). */
  actingForIsAdmin: boolean;
}

export interface RepoContext {
  now: string;
  repo: Repository;
  /** Running and paused runs on the repository, with their non-final nodes' current attempts. */
  runs: Array<{ run: Run; activeAttempts: string[] }>;
  settings: Settings;
}

// ---------- Transitions ----------

/** Lookup and record items a transition writes alongside its entities (described as data; the store writes them). */
export type RecordWrite =
  | { kind: "put"; key: { pk: string; sk: string }; attrs: Record<string, unknown> }
  /** Set these fields, creating the item if absent, keeping its other fields. */
  | { kind: "update"; key: { pk: string; sk: string }; attrs: Record<string, unknown> }
  | { kind: "delete"; key: { pk: string; sk: string } };

/** Atomic additions to the Run item, written outside the version check. */
export interface Counters {
  counts?: Partial<Record<NodeState, number>>;
  costUsd?: number;
}

export interface AttemptTransition {
  attempt?: Attempt;
  node?: NodeRunState;
  intents: IntentSpec[];
  decisions: DecisionSpec[];
  counters?: Counters;
  records?: RecordWrite[];
}

export interface RunTransition {
  run?: Run;
  /** Node rows the run machine updates (only node bookkeeping, never attempts). */
  nodes?: NodeRunState[];
  intents: IntentSpec[];
  decisions: DecisionSpec[];
  counters?: Counters;
  records?: RecordWrite[];
}

export interface RepoTransition {
  repo?: Repository;
  intents: IntentSpec[];
  decisions: DecisionSpec[];
}

export type AttemptHandler = (ctx: AttemptContext, input: AttemptInput) => AttemptTransition | undefined;
export type RunHandler = (ctx: RunContext, input: RunInput) => RunTransition | undefined;
export type RepoHandler = (ctx: RepoContext, input: RepoInput) => RepoTransition | undefined;

export const ORCHESTRATOR = "orchestrator";
