import { CloudWatchLogsClient, GetQueryResultsCommand, StartQueryCommand } from "@aws-sdk/client-cloudwatch-logs";
import { contentHash } from "@rovara-orch/dag-import";

/**
 * The load driver (T121). Against a deployed `load` stage: a 1200-node DAG at concurrency 1000,
 * through the operator API, with the fake Rovara and GitHub behind the real routes. It measures
 * SC-003 (95% of eligible nodes started within 60 s while capacity is free), SC-007 (1000
 * concurrent nodes, none lost or started twice), SC-009 (trace steps visible within 10 s) and the
 * share of transitions retried after a version conflict.
 */
export interface LoadEnv {
  apiUrl: string;
  token: string;
  fakesUrl: string;
  fakesSecret: string;
  consumerLogGroup?: string;
}

export function loadEnv(env = process.env): LoadEnv {
  const need = (k: string) => {
    if (!env[k]) throw new Error(`${k} is not set`);
    return env[k]!;
  };
  return { apiUrl: need("ROVARA_ORCH_URL").replace(/\/$/, ""), token: need("LOAD_TOKEN"), fakesUrl: need("FAKE_SERVICES_URL").replace(/\/$/, ""), fakesSecret: need("FAKE_SERVICES_SECRET"), consumerLogGroup: env.LOAD_CONSUMER_LOG_GROUP };
}

/** A speckit-dag file: Foundational, then `n - 1` stories that each depend only on it, each with its own file. */
export function buildLoadDag(n: number, repo = "acme/mono"): Record<string, unknown> {
  const dir = "specs/900-load";
  const story = (i: number) => `US${String(i).padStart(4, "0")}`;
  const task = (id: string, group: string, file: string, line: number) => ({
    id, title: `Implement ${file}`, group, section: null, parallel: false, story: null, files: [file], status: "todo",
    ref: `${dir}/tasks.md#${id}`, line, end_line: line, tags: [], text: `- [ ] ${id} Implement ${file}`,
  });
  const groups: Array<Record<string, unknown>> = [];
  const nodes: Array<Record<string, unknown>> = [];
  const edges: Array<Record<string, unknown>> = [];
  for (let i = 0; i < n; i++) {
    const id = i === 0 ? "foundational" : story(i);
    const kind = i === 0 ? "foundational" : "story";
    const file = i === 0 ? "src/core.ts" : `src/stories/${id.toLowerCase()}.ts`;
    const line = 10 + i * 4;
    const text = `## ${id}\n\n- [ ] T${i} Implement ${file}`;
    groups.push({ id, name: id, kind, order: i, story: i === 0 ? null : id, priority: i === 0 ? null : "P2", mvp: false, line, end_line: line + 2, text });
    nodes.push({ id, title: id, group: id, kind, story: i === 0 ? null : id, priority: i === 0 ? null : "P2", mvp: false, files: [file], status: "todo", line, end_line: line + 2, text, tasks: [task(`T${i}`, id, file, line + 2)] });
    if (i > 0) edges.push({ from: "foundational", to: id, reasons: ["phase"], via: [{ from: "T0", to: `T${i}` }] });
  }
  const graph: Record<string, unknown> = {
    version: 1,
    unit: "story",
    feature: "Load test",
    source: `${dir}/tasks.md`,
    spec: { id: "900-load", dir, tasks: `${dir}/tasks.md`, docs: { spec: `${dir}/spec.md` }, repo: `git@github.com:${repo}.git`, branch: "main", commit: "0".repeat(39) + "1", dirty: false, pushed: true },
    groups,
    nodes,
    edges,
    waves: [["foundational"], nodes.slice(1).map((x) => x.id)],
    warnings: [],
  };
  graph.hash = contentHash(graph);
  return graph;
}

async function call<T>(e: LoadEnv, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${e.apiUrl}${path}`, { method, headers: { authorization: `Bearer ${e.token}`, "content-type": "application/json", "idempotency-key": `${method}:${path}:${Date.now()}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${json.error?.message ?? ""}`);
  return json;
}

async function fakes<T>(e: LoadEnv, method: string, ...args: unknown[]): Promise<T> {
  const res = await fetch(`${e.fakesUrl}/control`, { method: "POST", headers: { "content-type": "application/json", "x-load-secret": e.fakesSecret }, body: JSON.stringify({ method, args }) });
  const json = (await res.json()) as { result: T; error?: { message: string } };
  if (json.error) throw new Error(`fakes.${method}: ${json.error.message}`);
  return json.result;
}

interface RunView { state: string; counts: Record<string, number>; nodes: Array<{ nodeId: string; state: string }> }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ACTIVE = ["running", "checks_failed", "pr_open", "in_merge_queue"];
const startedOrBeyond = (s: string) => [...ACTIVE, "merged"].includes(s);

export interface LoadResult {
  runId: string;
  peakActive: number;
  startedWithin60s: number;
  capacity: number;
  merged: number;
  nodes: number;
  conversations: number;
  traceLatencyP95Ms: number | null;
  versionConflictShare: number | null;
}

export async function runLoad(e: LoadEnv, o: { nodes: number; concurrency: number; timeoutMs: number }): Promise<LoadResult> {
  await fakes(e, "configure", { orchestratorUrl: e.apiUrl });
  const dag = buildLoadDag(o.nodes);
  const { dagId } = await call<{ dagId: string }>(e, "POST", "/v1/dags", dag);
  const { runId } = await call<{ runId: string }>(e, "POST", "/v1/runs", { dagId, concurrencyLimit: o.concurrency, costLimitUsd: 1_000_000 });
  const startedAt = Date.now();
  let foundationalMergedAt: number | null = null;
  let startedWithin60s = 0;
  let peakActive = 0;
  let run: RunView | undefined;
  const traceLatencies: number[] = [];
  while (Date.now() - startedAt < o.timeoutMs) {
    run = await call<RunView>(e, "GET", `/v1/runs/${runId}`);
    const active = run.nodes.filter((n) => ACTIVE.includes(n.state)).length;
    peakActive = Math.max(peakActive, active);
    const foundational = run.nodes.find((n) => n.nodeId === "foundational")!;
    if (foundationalMergedAt === null && foundational.state === "merged") foundationalMergedAt = Date.now();
    if (foundationalMergedAt !== null && Date.now() - foundationalMergedAt <= 60_000) {
      startedWithin60s = run.nodes.filter((n) => n.nodeId !== "foundational" && startedOrBeyond(n.state)).length;
    }
    // SC-009: how long after Rovara sent it does a step become readable? Sample one running node per poll.
    const sample = run.nodes.find((n) => n.state === "running");
    if (sample) {
      const t = await call<{ steps: Array<{ at: string }> }>(e, "GET", `/v1/runs/${runId}/nodes/${sample.nodeId}/trace?limit=500`);
      const last = t.steps.at(-1);
      if (last) traceLatencies.push(Date.now() - Date.parse(last.at));
    }
    if (run.state === "complete" || run.state === "cancelled") break;
    await sleep(5_000);
  }
  const stats = await fakes<{ conversations: number; merges: number }>(e, "stats");
  traceLatencies.sort((a, b) => a - b);
  return {
    runId,
    peakActive,
    startedWithin60s,
    capacity: Math.min(o.concurrency, o.nodes - 1),
    merged: run?.counts.merged ?? 0,
    nodes: o.nodes,
    conversations: stats.conversations,
    // The page polls every 2 s, so what a reader sees is at most this plus 2 s.
    traceLatencyP95Ms: traceLatencies.length ? traceLatencies[Math.floor(traceLatencies.length * 0.95)]! : null,
    versionConflictShare: e.consumerLogGroup ? await conflictShare(e.consumerLogGroup, startedAt) : null,
  };
}

/** Version-conflict retries over consumed inputs, from the work consumer's logs. */
async function conflictShare(logGroup: string, since: number): Promise<number> {
  const logs = new CloudWatchLogsClient({});
  const q = await logs.send(
    new StartQueryCommand({
      logGroupName: logGroup,
      startTime: Math.floor(since / 1000),
      endTime: Math.floor(Date.now() / 1000),
      queryString: `filter event in ["consume.done", "consume.version_conflict"] | stats sum(event = "consume.done") as done, sum(event = "consume.version_conflict") as conflicts`,
    }),
  );
  for (;;) {
    await sleep(2_000);
    const r = await logs.send(new GetQueryResultsCommand({ queryId: q.queryId! }));
    if (r.status === "Complete") {
      const row = Object.fromEntries((r.results?.[0] ?? []).map((f) => [f.field, Number(f.value)]));
      return row.done ? (row.conflicts ?? 0) / row.done : 0;
    }
    if (r.status === "Failed" || r.status === "Cancelled") throw new Error(`log query ${r.status}`);
  }
}
