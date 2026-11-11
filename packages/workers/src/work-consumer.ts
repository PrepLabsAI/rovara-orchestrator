import {
  attemptMachine,
  enqueue,
  FINAL_NODE_STATES,
  repositoryMachine,
  runMachine,
  type AttemptContext,
  type AttemptInput,
  type AttemptTransition,
  type Intent,
  type IntentSpec,
  type NodeState,
  type QueueMessage,
  type RepoContext,
  type RepoInput,
  type RepoTransition,
  type RunContext,
  type RunInput,
  type RunTransition,
} from "@rovara-orch/core";
import { applyTransition, DuplicateInput, ownerPk, unlockOps, VersionConflict } from "@rovara-orch/store";
import { loadAttemptContext, loadRepoContext, loadRunContext } from "./contexts.js";
import type { Deps } from "./ports.js";
import { reconcile } from "./github-reconcile.js";
import { runSchedulerPass } from "./scheduler.js";

export interface Machines {
  attempt: (ctx: AttemptContext, input: AttemptInput) => AttemptTransition | undefined;
  run: (ctx: RunContext, input: RunInput) => RunTransition | undefined;
  repository: (ctx: RepoContext, input: RepoInput) => RepoTransition | undefined;
}

export const DEFAULT_MACHINES: Machines = { attempt: attemptMachine, run: runMachine, repository: repositoryMachine };

const MAX_TRIES = 5;
/** Node states after which a scheduler pass may find work: capacity freed or a dependent unblocked. */
const FREES_CAPACITY: readonly NodeState[] = ["merged", "skipped", "escalated", "cancelled", "waiting"];

/** A scheduler pass for the repository, keyed so there is at most one per repository every 5 seconds. */
export function schedulePassIntent(repo: string, now: string): IntentSpec {
  const bucket = Math.floor(Date.parse(now) / 5000);
  return enqueue({ group: `repo:${repo}`, input: { kind: "schedule" } }, `sched:${repo}:${bucket}`);
}

export type ConsumeResult = { outcome: "applied" | "noop" | "duplicate" | "missing"; intents: Intent[] };

/**
 * Process one queue message: load the machine's context, compute the transition and write it with
 * the input's marker, retrying from a fresh read when the context changed underneath. Nothing here
 * sends to the queue: follow-up inputs are written as enqueue intents in the same transaction.
 */
export async function consume(deps: Deps, msg: QueueMessage, machines: Machines = DEFAULT_MACHINES): Promise<ConsumeResult> {
  for (let i = 0; i < MAX_TRIES; i++) {
    try {
      if (msg.group.startsWith("att:")) return await consumeAttempt(deps, msg.group.slice(4), msg.input as AttemptInput, msg.inputId, machines);
      if (msg.group.startsWith("run:")) return await consumeRun(deps, msg.group.slice(4), msg.input as RunInput, msg.inputId, machines);
      if (msg.group.startsWith("repo:")) return await consumeRepo(deps, msg.group.slice(5), msg.input as RepoInput, msg.inputId, machines);
      throw new Error(`unknown group ${msg.group}`);
    } catch (e) {
      if (e instanceof DuplicateInput) return { outcome: "duplicate", intents: [] };
      if (!(e instanceof VersionConflict)) throw e;
      deps.log?.({ event: "consume.version_conflict", group: msg.group, inputId: msg.inputId, try: i + 1 });
    }
  }
  throw new Error(`gave up on ${msg.inputId} after ${MAX_TRIES} version conflicts`);
}

async function consumeAttempt(deps: Deps, attemptId: string, input: AttemptInput, inputId: string, machines: Machines): Promise<ConsumeResult> {
  const ctx = await loadAttemptContext(deps, attemptId);
  if (!ctx) return { outcome: "missing", intents: [] };
  const t = machines.attempt(ctx, input);
  if (!t) return { outcome: "noop", intents: [] };
  const intents = [...t.intents];
  const extra = [];
  const before = ctx.node.state;
  const after = t.node?.state ?? before;
  if (after !== before) {
    if (FREES_CAPACITY.includes(after)) intents.push(schedulePassIntent(ctx.run.repo, ctx.now));
    if (FINAL_NODE_STATES.includes(after)) {
      intents.push(
        enqueue({ group: `run:${ctx.run.runId}`, input: { kind: "node_finished", nodeId: ctx.node.nodeId, state: after } }, `fin:${ctx.run.runId}:${ctx.node.nodeId}`),
      );
      extra.push(...unlockOps(ctx.run.repo, ctx.dagNode));
    }
  }
  const written = await applyTransition(deps.table, {
    owner: ownerPk.attempt(attemptId),
    inputId,
    runId: ctx.run.runId,
    now: ctx.now,
    before: { attempt: ctx.attempt, node: ctx.node, run: ctx.run },
    after: { ...t, intents },
    extra,
  });
  return { outcome: "applied", intents: written };
}

async function consumeRun(deps: Deps, runId: string, input: RunInput, inputId: string, machines: Machines): Promise<ConsumeResult> {
  const ctx = await loadRunContext(deps, runId);
  if (!ctx) return { outcome: "missing", intents: [] };
  const t = machines.run(ctx, input);
  if (!t) return { outcome: "noop", intents: [] };
  const intents = [...t.intents];
  if (t.run && t.run.state !== ctx.run.state) intents.push(schedulePassIntent(ctx.run.repo, ctx.now));
  const written = await applyTransition(deps.table, {
    owner: ownerPk.run(runId),
    inputId,
    runId,
    now: ctx.now,
    before: { run: ctx.run, nodes: ctx.nodes },
    after: { ...t, intents },
  });
  return { outcome: "applied", intents: written };
}

async function consumeRepo(deps: Deps, repo: string, input: RepoInput, inputId: string, machines: Machines): Promise<ConsumeResult> {
  if (input.kind === "schedule") {
    const intents = await runSchedulerPass(deps, repo);
    return { outcome: "applied", intents };
  }
  if (input.kind === "reconcile_pr") {
    const intents = await reconcile(deps, repo, input.attemptId);
    return { outcome: intents.length ? "applied" : "noop", intents };
  }
  const ctx = await loadRepoContext(deps, repo);
  const t = machines.repository(ctx, input);
  if (!t) return { outcome: "noop", intents: [] };
  const intents = [...t.intents];
  if (t.repo && t.repo.paused !== ctx.repo.paused) intents.push(schedulePassIntent(repo, ctx.now));
  const written = await applyTransition(deps.table, {
    owner: ownerPk.repo(repo),
    inputId,
    runId: null,
    now: ctx.now,
    before: { repo: ctx.repo },
    after: { ...t, intents },
  });
  return { outcome: "applied", intents: written };
}
