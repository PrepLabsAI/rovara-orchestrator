import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { CliFailure, EXIT, expectOk, print, type CliContext } from "../context.js";

interface DagSummary {
  dagId: string;
  feature: string | null;
  repo: string;
  commit: string;
  nodeCount: number;
  hash: string;
  importedAt: string;
  importedBy: string;
}

/** dag import | list | show (contracts/cli.md). */
export function register(program: Command, ctx: () => CliContext): void {
  const dag = program.command("dag").description("Import and inspect DAGs");

  dag
    .command("import <file>")
    .description("Import a speckit-dag JSON file (built with --unit story)")
    .action(async (file: string) => {
      const c = ctx();
      let body: unknown;
      try {
        body = JSON.parse(await readFile(file, "utf8"));
      } catch (e) {
        throw new CliFailure(EXIT.usage, `cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
      }
      const r = expectOk(await c.api.request("POST", "/v1/dags", body)) as { dagId: string; created: boolean; hash: string };
      print(c, r, () => [`Imported ${r.dagId} (${r.created ? "new" : "already stored; same hash"}).`]);
    });

  dag
    .command("list")
    .description("List stored DAGs")
    .action(async () => {
      const c = ctx();
      const r = expectOk(await c.api.request("GET", "/v1/dags")) as { items: DagSummary[] };
      print(c, r, () =>
        r.items.length
          ? r.items.map((d) => `${d.dagId}  ${d.feature ?? "-"}  ${d.repo}@${d.commit.slice(0, 12)}  ${d.nodeCount} nodes  ${d.importedAt}`)
          : ["No DAGs yet."],
      );
    });

  dag
    .command("show <dagId>")
    .description("Show one DAG with its nodes")
    .action(async (dagId: string) => {
      const c = ctx();
      const r = expectOk(await c.api.request("GET", `/v1/dags/${encodeURIComponent(dagId)}`)) as DagSummary & {
        nodes: Array<{ nodeId: string; title: string; dependsOn: string[] }>;
      };
      print(c, r, () => [
        `${r.dagId}  ${r.feature ?? "-"}  ${r.repo}@${r.commit.slice(0, 12)}  ${r.hash}`,
        ...r.nodes.map((n) => `  ${n.nodeId}  ${n.title}${n.dependsOn.length ? `  (after ${n.dependsOn.join(", ")})` : ""}`),
      ]);
    });
}
