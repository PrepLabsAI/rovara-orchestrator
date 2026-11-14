import { importDag, ImportRefused } from "@rovara-orch/dag-import";
import { decisionOps } from "@rovara-orch/store";
import { ApiError } from "../errors.js";
import type { Route } from "../types.js";

const summary = (d: { dagId: string; feature: string | null; repo: string; commit: string; nodeCount: number; hash: string; importedAt: string; importedBy: string }) => ({
  dagId: d.dagId,
  feature: d.feature,
  repo: d.repo,
  commit: d.commit,
  nodeCount: d.nodeCount,
  hash: d.hash,
  importedAt: d.importedAt,
  importedBy: d.importedBy,
});

/** DAG routes (US1, contracts/operator-api.md). */
export const routes: Route[] = [
  {
    method: "POST",
    pattern: "/v1/dags",
    handler: async ({ req, deps, operator }) => {
      try {
        const r = await importDag(
          { table: deps.table, repos: deps.repos, github: deps.github, clock: deps.clock, ...(deps.storeLargeSource ? { storeLargeSource: deps.storeLargeSource } : {}) },
          req.body,
          operator.id,
        );
        if (r.created) {
          const now = deps.clock.now().toISOString();
          await deps.table.transact(decisionOps(null, [{ actor: operator.id, action: "import", reason: `imported ${r.dagId}`, detail: { dagId: r.dagId, hash: r.hash } }], now));
        }
        return { status: r.created ? 201 : 200, body: r };
      } catch (e) {
        if (e instanceof ImportRefused) throw new ApiError("INVALID", e.message, { problem: e.problem, ...(e.path ? { path: e.path } : {}) });
        throw e;
      }
    },
  },
  {
    method: "GET",
    pattern: "/v1/dags",
    handler: async ({ deps }) => {
      const dags = (await deps.repos.listDags(200)).sort((a, b) => b.importedAt.localeCompare(a.importedAt));
      return { status: 200, body: { items: dags.map(summary) } };
    },
  },
  {
    method: "GET",
    pattern: "/v1/dags/:dagId",
    handler: async ({ deps, params }) => {
      const dag = await deps.repos.getDag(params.dagId!);
      if (!dag) throw new ApiError("NOT_FOUND", `no DAG ${params.dagId}`);
      const nodes = await deps.repos.getDagNodes(dag.dagId);
      const edges = nodes.flatMap((n) => n.dependsOn.map((from) => ({ from, to: n.nodeId })));
      return { status: 200, body: { ...summary(dag), specDir: dag.specDir, docs: dag.docs, edgeCount: dag.edgeCount, nodes, edges } };
    },
  },
];
