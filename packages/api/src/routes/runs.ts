import {
  CONCURRENCY_MAX,
  CONCURRENCY_MIN,
  DEFAULT_RETRY,
  enqueue,
  newId,
  type NodeRunState,
  type RetryLimits,
  type Run,
} from "@rovara-orch/core";
import type { Intent } from "@rovara-orch/core";
import { ConditionFailed, decisionOps, encodeNode, encodeRun, intentOps, keys, type Op } from "@rovara-orch/store";
import { ApiError } from "../errors.js";
import type { ApiDeps, Route } from "../types.js";

const RETRY_FIELDS = ["fixRequests", "attempts", "prUpdates", "reviewRounds", "quietMinutes"] as const;

function parseStart(body: unknown): { dagId: string; concurrencyLimit: number; costLimitUsd: number; retry: RetryLimits } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.dagId !== "string" || !b.dagId) throw new ApiError("INVALID", "dagId is required", { problem: "dagId" });
  const c = b.concurrencyLimit;
  if (typeof c !== "number" || !Number.isInteger(c) || c < CONCURRENCY_MIN || c > CONCURRENCY_MAX) {
    throw new ApiError("INVALID", `concurrencyLimit must be a whole number from ${CONCURRENCY_MIN} to ${CONCURRENCY_MAX}`, { problem: "concurrencyLimit" });
  }
  const cost = b.costLimitUsd;
  if (typeof cost !== "number" || !(cost > 0)) throw new ApiError("INVALID", "costLimitUsd must be greater than 0", { problem: "costLimitUsd" });
  const retry: RetryLimits = { ...DEFAULT_RETRY };
  const r = (b.retry ?? {}) as Record<string, unknown>;
  for (const f of RETRY_FIELDS) {
    if (r[f] === undefined) continue;
    const v = r[f];
    if (typeof v !== "number" || !Number.isInteger(v) || v < (f === "quietMinutes" ? 1 : 0) || v > 1000) {
      throw new ApiError("INVALID", `retry.${f} must be a whole number`, { problem: `retry.${f}` });
    }
    retry[f] = v;
  }
  return { dagId: b.dagId, concurrencyLimit: c, costLimitUsd: cost, retry };
}

/**
 * Start a run (FR-010): node rows first (in batches), then the run, its list item and the DAG's
 * active-run item in one transaction, with the run_start and scheduler-pass inputs as intents.
 * A DAG with an active run is refused with 409.
 */
export async function startRun(deps: ApiDeps, operatorId: string, body: unknown): Promise<{ runId: string }> {
  const p = parseStart(body);
  const dag = await deps.repos.getDag(p.dagId);
  if (!dag) throw new ApiError("NOT_FOUND", `no DAG ${p.dagId}`);
  if (await deps.repos.getActiveRunId(dag.dagId)) throw new ApiError("CONFLICT", `${dag.dagId} already has an active run`);
  if (!(await deps.rovara.isLinked(operatorId))) {
    const linkUrl = await deps.rovara.linkUrl(operatorId);
    throw new ApiError("INVALID", "link your Rovara sign-in to the orchestrator's channel first", { problem: "not_linked", linkUrl });
  }
  const dagNodes = await deps.repos.getDagNodes(dag.dagId);
  const runId = newId("run");
  const now = deps.clock.now().toISOString();
  const nodes: NodeRunState[] = dagNodes.map((n) => ({
    runId,
    nodeId: n.nodeId,
    state: n.doneAtImport ? "merged" : "waiting",
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
  }));
  for (let i = 0; i < nodes.length; i += 90) {
    await deps.table.transact(nodes.slice(i, i + 90).map((n) => ({ kind: "put" as const, item: encodeNode(n) })));
  }
  const run: Run = {
    runId,
    dagId: dag.dagId,
    repo: dag.repo,
    state: "running",
    concurrencyLimit: p.concurrencyLimit,
    costLimitUsd: p.costLimitUsd,
    retry: p.retry,
    costUsd: 0,
    counts: { waiting: nodes.filter((n) => n.state === "waiting").length, merged: nodes.filter((n) => n.state === "merged").length },
    startedBy: operatorId,
    actingFor: operatorId,
    startedAt: now,
    endedAt: null,
    pausedFor: null,
    tracesExpireSetAt: null,
    version: 1,
  };
  const ops: Op[] = [
    { kind: "put", item: encodeRun(run), ifNotExists: true },
    { kind: "put", item: { ...keys.runListItem(now, runId), entityType: "RUNLIST", runId } },
    { kind: "put", item: { ...keys.dagActiveRun(dag.dagId), entityType: "DAGRUN", runId }, ifNotExists: true },
    ...intentOps(`RUN#${runId}`, [
      enqueue({ group: `run:${runId}`, input: { kind: "run_start" } }, `run_start:${runId}`),
      enqueue({ group: `repo:${dag.repo}`, input: { kind: "schedule" } }, `start-sched:${runId}`),
    ], now).ops,
    ...decisionOps(runId, [{ actor: operatorId, action: "start", reason: `started ${dag.dagId}`, detail: { concurrencyLimit: p.concurrencyLimit, costLimitUsd: p.costLimitUsd } }], now),
  ];
  try {
    await deps.table.transact(ops);
  } catch (e) {
    if (e instanceof ConditionFailed) throw new ApiError("CONFLICT", `${dag.dagId} already has an active run`);
    throw e;
  }
  return { runId };
}

/** One run with its nodes, as the status page and `run status` show it (FR-053). */
export async function runView(deps: ApiDeps, runId: string) {
  const run = await deps.repos.getRun(runId);
  if (!run) throw new ApiError("NOT_FOUND", `no run ${runId}`);
  const [nodes, dagNodes] = await Promise.all([deps.repos.getRunNodes(runId), deps.repos.getDagNodes(run.dagId)]);
  const titles = new Map(dagNodes.map((n) => [n.nodeId, { title: n.title, order: n.order }]));
  const items = await Promise.all(
    nodes.map(async (n) => {
      const attempt = n.currentAttempt ? await deps.repos.getAttempt(n.currentAttempt) : undefined;
      return {
        nodeId: n.nodeId,
        title: titles.get(n.nodeId)?.title ?? n.nodeId,
        order: titles.get(n.nodeId)?.order ?? 0,
        state: n.state,
        waitingFor: n.waitingFor,
        attempt: attempt?.n ?? null,
        rovaraTaskUrl: attempt?.rovaraTaskUrl ?? null,
        pullRequests: attempt?.pullRequests.map((p) => ({ number: p.number, url: p.url, state: p.state })) ?? [],
      };
    }),
  );
  items.sort((a, b) => a.order - b.order);
  const { version: _v, ...rest } = run;
  return { ...rest, nodes: items.map(({ order: _o, ...i }) => i), notifications: await undelivered(deps, runId) };
}

/** Slack notifications for the run that have not reached Slack yet; they stay visible until they do (FR-035). */
async function undelivered(deps: ApiDeps, runId: string) {
  const pending = await deps.table.queryIndex<Intent & { lastError?: string }>("PENDING_INTENT", {});
  return pending
    .filter((i) => (i.effect === "slack.post" || i.effect === "slack.reply") && (i.payload.params as { runId?: string } | undefined)?.runId === runId)
    .map((i) => ({
      key: i.key,
      nodeId: (i.payload.params as { nodeId?: string }).nodeId ?? null,
      template: i.payload.template ?? null,
      delivered: false,
      tries: i.tries,
      lastError: i.lastError ?? null,
      since: i.createdAt,
    }));
}

export const routes: Route[] = [
  {
    method: "POST",
    pattern: "/v1/runs",
    handler: async ({ deps, operator, req }) => ({ status: 201, body: await startRun(deps, operator.id, req.body) }),
  },
  {
    method: "GET",
    pattern: "/v1/runs",
    handler: async ({ deps, req }) => {
      const state = req.query.state;
      const runs = (await deps.repos.listRuns(200)).filter((r) => !state || r.state === state);
      return { status: 200, body: { items: runs.map(({ version: _v, ...r }) => r) } };
    },
  },
  {
    method: "GET",
    pattern: "/v1/runs/:runId",
    handler: async ({ deps, params }) => ({ status: 200, body: await runView(deps, params.runId!) }),
  },
];
