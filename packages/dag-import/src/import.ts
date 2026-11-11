import { newId, type Clock, type Dag, type DagNode } from "@rovara-orch/core";
import { ConditionFailed, encodeDag, encodeDagNode, keys, type Repositories, type Table } from "@rovara-orch/store";
import { findCycle, unknownEdgeEnds } from "./graph.js";
import { contentHash } from "./hash.js";
import { checkSource, normalizeRepo, type RemoteCheck } from "./remote.js";
import { GraphSchema, type Graph } from "./schema.js";

export { normalizeRepo };

/** Refusal reasons, in the order they are checked (FR-001 to FR-003). */
export const PROBLEMS = [
  "schema",
  "version",
  "unit",
  "hash_mismatch",
  "cycle",
  "unknown_node",
  "spec_dirty",
  "spec_not_pushed",
  "commit_not_on_remote",
] as const;
export type Problem = (typeof PROBLEMS)[number];

export type Validation =
  | { ok: true; graph: Graph & { repo: string } }
  | { ok: false; problem: Problem; message: string; path?: string };

/** Check a speckit-dag file; the first problem found is reported. */
export async function validateDag(json: unknown, github: RemoteCheck): Promise<Validation> {
  const parsed = GraphSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, problem: "schema", message: issue?.message ?? "not a speckit-dag graph", path: issue?.path.join(".") };
  }
  const graph = parsed.data;
  if (graph.version !== 1) return { ok: false, problem: "version", message: `version ${graph.version} is not supported; expected 1`, path: "version" };
  if (graph.unit !== "story") return { ok: false, problem: "unit", message: `unit "${graph.unit}" is not supported; build the graph with --unit story`, path: "unit" };
  const recomputed = contentHash(json as Record<string, unknown>);
  if (recomputed !== graph.hash) return { ok: false, problem: "hash_mismatch", message: `the recorded hash ${graph.hash} does not match the content (${recomputed})`, path: "hash" };
  const cycle = findCycle(graph.nodes, graph.edges);
  if (cycle.length) return { ok: false, problem: "cycle", message: `dependency cycle: ${cycle.join(" -> ")}`, path: "edges" };
  const unknown = unknownEdgeEnds(graph.nodes, graph.edges);
  if (unknown.length) {
    const u = unknown[0]!;
    return { ok: false, problem: "unknown_node", message: `edge ${u.edge.from} -> ${u.edge.to} names unknown node ${u.missing}`, path: "edges" };
  }
  const source = await checkSource(graph, github);
  if ("problem" in source) return { ok: false, problem: source.problem, message: source.message, path: "spec" };
  return { ok: true, graph: { ...graph, repo: source.repo } };
}

export class ImportRefused extends Error {
  constructor(
    readonly problem: Problem,
    message: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = "ImportRefused";
  }
}

export interface ImportDeps {
  table: Table;
  repos: Repositories;
  github: RemoteCheck;
  clock: Clock;
  /** Keeps an imported file over 300 KB out of the table; returns its key. */
  storeLargeSource?(dagId: string, body: string): Promise<string>;
}

export const LARGE_SOURCE_BYTES = 300 * 1024;
const BATCH = 90;

export function toDagNodes(dagId: string, graph: Graph): DagNode[] {
  const deps = new Map<string, string[]>();
  for (const e of graph.edges) deps.set(e.to, [...(deps.get(e.to) ?? []), e.from]);
  return graph.nodes.map((n, order) => ({
    dagId,
    nodeId: n.id,
    title: n.title,
    kind: n.kind ?? "other",
    priority: n.priority ?? null,
    mvp: !!n.mvp,
    files: n.files ?? [],
    tasks: (n.tasks ?? []).map((t) => ({ id: t.id, title: t.title, text: t.text, ref: t.ref, files: t.files })),
    dependsOn: [...new Set(deps.get(n.id) ?? [])],
    doneAtImport: n.status === "done",
    order,
  }));
}

/**
 * Import a graph. Node items are written first, in batches, under the new dag-id; the DAG item and
 * its hash identity item come last, in one conditional transaction, so a DAG becomes visible only
 * when complete. A graph with a known hash returns the existing dag-id (FR-005).
 */
export async function importDag(
  deps: ImportDeps,
  json: unknown,
  importedBy: string,
  rawBody?: string,
): Promise<{ dagId: string; hash: string; created: boolean }> {
  const v = await validateDag(json, deps.github);
  if (!v.ok) throw new ImportRefused(v.problem, v.message, v.path);
  const graph = v.graph;
  const existing = await deps.repos.findDagByHash(graph.repo, graph.hash);
  if (existing) return { dagId: existing, hash: graph.hash, created: false };

  const dagId = newId("dag");
  const nodes = toDagNodes(dagId, graph);
  for (let i = 0; i < nodes.length; i += BATCH) {
    await deps.table.transact(nodes.slice(i, i + BATCH).map((n) => ({ kind: "put" as const, item: encodeDagNode(n) })));
  }
  const body = rawBody ?? JSON.stringify(json);
  let sourceKey: string | undefined;
  let sourceJson: string | undefined;
  if (Buffer.byteLength(body, "utf8") > LARGE_SOURCE_BYTES) {
    if (!deps.storeLargeSource) throw new ImportRefused("schema", "the file is over 300 KB and no file store is configured");
    sourceKey = await deps.storeLargeSource(dagId, body);
  } else {
    sourceJson = body;
  }
  const dag: Dag = {
    dagId,
    hash: graph.hash,
    repo: graph.repo,
    commit: graph.spec.commit!,
    specDir: graph.spec.dir,
    docs: graph.spec.docs ?? {},
    feature: graph.feature ?? null,
    unit: "story",
    nodeCount: nodes.length,
    edgeCount: graph.edges.length,
    importedAt: deps.clock.now().toISOString(),
    importedBy,
    ...(sourceKey ? { sourceKey } : {}),
  };
  try {
    await deps.table.transact([
      { kind: "put", item: { ...encodeDag(dag), ...(sourceJson ? { sourceJson } : {}) }, ifNotExists: true },
      { kind: "put", item: { ...keys.dagHash(graph.repo, graph.hash), entityType: "DAGHASH", dagId }, ifNotExists: true },
    ]);
  } catch (e) {
    if (!(e instanceof ConditionFailed)) throw e;
    const winner = await deps.repos.findDagByHash(graph.repo, graph.hash);
    if (!winner) throw e;
    return { dagId: winner, hash: graph.hash, created: false };
  }
  return { dagId, hash: graph.hash, created: true };
}
