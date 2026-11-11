import type {
  Attempt,
  Counters,
  DecisionSpec,
  Intent,
  IntentSpec,
  NodeRunState,
  NodeState,
  Repository,
  Run,
} from "@rovara-orch/core";
import { monotonicFactory } from "ulid";
import { gsi, keys, ownerPk } from "./keys.js";
import { attemptFields, countAttr, nodeFields, repoFields, runFields, versionedWrite } from "./repositories.js";
import { ConditionFailed, type Op, type Table } from "./table.js";

const nextSeq = monotonicFactory();

/** The input was already processed: its marker exists. Nothing was written. */
export class DuplicateInput extends Error {
  constructor(readonly inputId: string) {
    super(`input ${inputId} was already processed`);
    this.name = "DuplicateInput";
  }
}

export interface TransitionWrite {
  /** Where intents and the input marker live: `ATT#…`, `RUN#…` or `REPO#…`. */
  owner: string;
  /** The queue input being processed; its marker makes reprocessing a no-op. */
  inputId?: string;
  /** The run decisions belong to (null for repository-level decisions). */
  runId: string | null;
  now: string;
  /** Entities as read before the transition (their versions are the expected versions). */
  before: { attempt?: Attempt; node?: NodeRunState; run?: Run; repo?: Repository; nodes?: NodeRunState[] };
  after: {
    attempt?: Attempt;
    node?: NodeRunState;
    run?: Run;
    repo?: Repository;
    nodes?: NodeRunState[];
    intents: IntentSpec[];
    decisions: DecisionSpec[];
    counters?: Counters;
  };
  /** Extra ops written in the same transaction (e.g. a stored event, a question record). */
  extra?: Op[];
}

export function intentItem(owner: string, spec: IntentSpec, now: string): Intent {
  const seq = nextSeq();
  const key = keys.intent(owner, seq);
  return { ...spec, pk: key.pk, sk: key.sk, seq, status: "pending", result: null, tries: 0, nextTryAt: now, createdAt: now };
}

/** Ops that write new pending intents, indexed for the sweep's re-drive. */
export function intentOps(owner: string, specs: IntentSpec[], now: string): { ops: Op[]; intents: Intent[] } {
  const intents = specs.map((s) => intentItem(owner, s, now));
  const ops: Op[] = intents.map((i) => ({
    kind: "put",
    item: { ...i, entityType: "INTENT", ...gsi.pendingIntent(i.nextTryAt, i.pk, i.sk) },
    ifNotExists: true,
  }));
  return { ops, intents };
}

export function decisionOps(runId: string | null, decisions: DecisionSpec[], now: string): Op[] {
  return decisions.map((d) => {
    const id = `dec_${nextSeq()}`;
    const key = runId ? keys.decision(runId, now, id) : { pk: "DECISIONS#GLOBAL", sk: `DEC#${now}#${id}` };
    return { kind: "put", item: { ...key, entityType: "DECISION", id, runId, at: now, ...d } };
  });
}

export function counterOp(runId: string, counters: Counters | undefined): Op | undefined {
  if (!counters) return undefined;
  const add: Record<string, number> = {};
  for (const [state, delta] of Object.entries(counters.counts ?? {})) {
    if (delta) add[countAttr(state as NodeState)] = delta;
  }
  if (counters.costUsd) add.costUsd = counters.costUsd;
  return Object.keys(add).length ? { kind: "update", key: keys.run(runId), add } : undefined;
}

/**
 * Write a machine transition atomically: entity updates (version-checked), new intents, decisions,
 * counter additions and the input marker, in one transaction. Throws DuplicateInput when the input
 * was already processed, VersionConflict when an entity changed underneath.
 */
export async function applyTransition(table: Table, w: TransitionWrite): Promise<Intent[]> {
  const ops: Op[] = [];
  const { before, after } = w;
  if (w.inputId) ops.push({ kind: "put", item: { ...keys.input(w.owner, w.inputId), entityType: "INPUT", at: w.now }, ifNotExists: true });
  if (after.attempt && before.attempt) {
    ops.push({ kind: "update", key: keys.attempt(after.attempt.attemptId), set: attemptFields(after.attempt), expectedVersion: before.attempt.version });
  }
  if (after.node && before.node) {
    ops.push({ kind: "update", key: keys.runNode(after.node.runId, after.node.nodeId), set: nodeFields(after.node), expectedVersion: before.node.version });
  }
  for (const n of after.nodes ?? []) {
    const prev = before.nodes?.find((b) => b.nodeId === n.nodeId);
    if (!prev) throw new Error(`node ${n.nodeId} changed without its prior version`);
    ops.push({ kind: "update", key: keys.runNode(n.runId, n.nodeId), set: nodeFields(n), expectedVersion: prev.version });
  }
  if (after.run && before.run) {
    ops.push({ kind: "update", key: keys.run(after.run.runId), set: runFields(after.run), expectedVersion: before.run.version });
  }
  if (after.repo) ops.push(versionedWrite(keys.repo(after.repo.repo), repoFields(after.repo), before.repo?.version ?? 0));
  const runId = after.run?.runId ?? before.run?.runId ?? w.runId;
  if (runId) {
    const c = counterOp(runId, after.counters);
    if (c) ops.push(c);
  }
  const { ops: iops, intents } = intentOps(w.owner, after.intents, w.now);
  ops.push(...iops, ...decisionOps(w.runId, after.decisions, w.now), ...(w.extra ?? []));
  try {
    await table.transact(ops);
  } catch (e) {
    if (e instanceof ConditionFailed && w.inputId) {
      const marker = keys.input(w.owner, w.inputId);
      const onlyMarker = e.failed.every((op) => op.kind === "put" && op.item.pk === marker.pk && op.item.sk === marker.sk);
      if (onlyMarker) throw new DuplicateInput(w.inputId);
    }
    throw e;
  }
  return intents;
}

export { ownerPk };
