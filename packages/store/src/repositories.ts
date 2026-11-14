import {
  DEFAULT_SETTINGS,
  emptyRepository,
  NODE_STATES,
  type Attempt,
  type Dag,
  type DagNode,
  type NodeRunState,
  type NodeState,
  type Repository,
  type Run,
  type Settings,
} from "@rovara-orch/core";
import { gsi, keys, type Key } from "./keys.js";
import type { Item, Op, Table } from "./table.js";

const strip = (item: Record<string, unknown>) => {
  const { pk: _pk, sk: _sk, entityType: _e, gsi1pk: _g1, gsi1sk: _g2, ...rest } = item;
  return rest;
};

// ---------- Run: counters live in top-level attributes c_<state> so they can be ADDed ----------

export const countAttr = (state: NodeState) => `c_${state}`;

export function runFields(run: Run): Record<string, unknown> {
  const { counts: _c, costUsd: _cost, version: _v, ...rest } = run;
  return {
    ...rest,
    entityType: "RUN",
    ...(run.state === "running" || run.state === "paused"
      ? gsi.activeRun(run.repo, run.runId)
      : { gsi1pk: undefined, gsi1sk: undefined }),
  };
}

export function encodeRun(run: Run): Item {
  const item: Item = { ...keys.run(run.runId), ...runFields(run), costUsd: run.costUsd, version: run.version };
  for (const s of NODE_STATES) item[countAttr(s)] = run.counts[s] ?? 0;
  if (item.gsi1pk === undefined) {
    delete item.gsi1pk;
    delete item.gsi1sk;
  }
  return item;
}

export function decodeRun(item: Record<string, unknown>): Run {
  const counts: Partial<Record<NodeState, number>> = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(strip(item))) {
    if (k.startsWith("c_")) counts[k.slice(2) as NodeState] = Number(v);
    else rest[k] = v;
  }
  return { ...(rest as unknown as Run), counts, costUsd: Number(item.costUsd ?? 0) };
}

// ---------- Attempt: earliest due time is indexed on gsi1 for the sweep ----------

export function earliestDue(a: Attempt): string | null {
  const times = [a.due.quietAt, a.due.reviewAt, a.due.retryAt].filter((t): t is string => !!t);
  return times.length ? times.sort()[0]! : null;
}

export function attemptFields(a: Attempt): Record<string, unknown> {
  const { version: _v, ...rest } = a;
  const due = earliestDue(a);
  return {
    ...rest,
    entityType: "ATTEMPT",
    ...(due ? gsi.due(due, a.attemptId) : { gsi1pk: undefined, gsi1sk: undefined }),
  };
}

export function encodeAttempt(a: Attempt): Item {
  const item: Item = { ...keys.attempt(a.attemptId), ...attemptFields(a), version: a.version };
  if (item.gsi1pk === undefined) {
    delete item.gsi1pk;
    delete item.gsi1sk;
  }
  return item;
}

export const decodeAttempt = (item: Record<string, unknown>) => strip(item) as unknown as Attempt;

// ---------- NodeRunState ----------

export function nodeFields(n: NodeRunState): Record<string, unknown> {
  const { version: _v, ...rest } = n;
  return { ...rest, entityType: "RUN_NODE" };
}
export const encodeNode = (n: NodeRunState): Item => ({ ...keys.runNode(n.runId, n.nodeId), ...nodeFields(n), version: n.version });
export const decodeNode = (item: Record<string, unknown>) => strip(item) as unknown as NodeRunState;

// ---------- DAG ----------

export const encodeDag = (d: Dag): Item => ({ ...keys.dag(d.dagId), entityType: "DAG", ...gsi.dagList(d.importedAt, d.dagId), ...d });
export const decodeDag = (item: Record<string, unknown>) => strip(item) as unknown as Dag;
export const encodeDagNode = (n: DagNode): Item => ({ ...keys.dagNode(n.dagId, n.nodeId), entityType: "DAG_NODE", ...n });
export const decodeDagNode = (item: Record<string, unknown>) => strip(item) as unknown as DagNode;

// ---------- Repository and Settings ----------

export function repoFields(r: Repository): Record<string, unknown> {
  const { version: _v, ...rest } = r;
  return { ...rest, entityType: "REPO" };
}
export const decodeRepo = (item: Record<string, unknown>) => strip(item) as unknown as Repository;

export function settingsFields(s: Settings): Record<string, unknown> {
  const { version: _v, ...rest } = s;
  return { ...rest, entityType: "SETTINGS" };
}

/** A versioned write of an entity: a put when it was never stored (version 0), else a version-checked update. */
export function versionedWrite(key: Key, fields: Record<string, unknown>, version: number): Op {
  if (version === 0) return { kind: "put", item: { ...key, ...stripUndefined(fields), version: 1 }, ifNotExists: true };
  return { kind: "update", key, set: fields, expectedVersion: version };
}

function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

/** Read access to every entity. Writes go through `applyTransition` or the explicit op builders. */
export class Repositories {
  constructor(readonly table: Table) {}

  async getDag(dagId: string): Promise<Dag | undefined> {
    const item = await this.table.get(keys.dag(dagId));
    return item ? decodeDag(item) : undefined;
  }

  async getDagNodes(dagId: string): Promise<DagNode[]> {
    const p = keys.dagNodesPrefix(dagId);
    return (await this.table.query(p.pk, p.skPrefix)).map(decodeDagNode).sort((a, b) => a.order - b.order);
  }

  async findDagByHash(repo: string, hash: string): Promise<string | undefined> {
    const item = await this.table.get<{ dagId: string }>(keys.dagHash(repo, hash));
    return item?.dagId;
  }

  async listDags(limit = 50): Promise<Dag[]> {
    return (await this.table.queryIndex("DAGS", { limit })).map(decodeDag);
  }

  async getRun(runId: string): Promise<Run | undefined> {
    const item = await this.table.get(keys.run(runId));
    return item ? decodeRun(item) : undefined;
  }

  async getActiveRunId(dagId: string): Promise<string | undefined> {
    return (await this.table.get<{ runId: string }>(keys.dagActiveRun(dagId)))?.runId;
  }

  async listActiveRuns(repo?: string): Promise<Run[]> {
    return (await this.table.queryIndex("ACTIVE_RUNS", repo ? { prefix: `${repo}#` } : {})).map(decodeRun);
  }

  /** Every run, newest first, from the run list items (`RUNS` / `<startedAt>#<runId>`). */
  async listRuns(limit = 50): Promise<Run[]> {
    const ids = await this.table.query<{ runId: string }>("RUNS", "", { limit, descending: true });
    const runs = await Promise.all(ids.map((i) => this.getRun(i.runId)));
    return runs.filter((r): r is Run => !!r);
  }

  async getRunNodes(runId: string): Promise<NodeRunState[]> {
    const p = keys.runNodesPrefix(runId);
    return (await this.table.query(p.pk, p.skPrefix)).map(decodeNode);
  }

  async getRunNode(runId: string, nodeId: string): Promise<NodeRunState | undefined> {
    const item = await this.table.get(keys.runNode(runId, nodeId));
    return item ? decodeNode(item) : undefined;
  }

  async getAttempt(attemptId: string): Promise<Attempt | undefined> {
    const item = await this.table.get(keys.attempt(attemptId));
    return item ? decodeAttempt(item) : undefined;
  }

  async getRepo(repo: string): Promise<Repository> {
    const item = await this.table.get(keys.repo(repo));
    return item ? decodeRepo(item) : emptyRepository(repo);
  }

  async getSettings(): Promise<Settings> {
    const item = await this.table.get(keys.settings());
    return item ? ({ ...DEFAULT_SETTINGS, ...strip(item) } as Settings) : { ...DEFAULT_SETTINGS, version: 0 };
  }

  async listDecisions(runId: string): Promise<Array<Record<string, unknown>>> {
    const p = keys.decisionsPrefix(runId);
    return (await this.table.query(p.pk, p.skPrefix)).map(strip);
  }

  /** Attempts whose earliest due time is at or before `now`. */
  async listDue(now: string, limit = 500): Promise<Attempt[]> {
    return (await this.table.queryIndex("DUE", { upTo: `${now}#￿`, limit })).map(decodeAttempt);
  }
}
