import { Option, type Command } from "commander";
import { CliFailure, EXIT, expectOk, print, type CliContext } from "../context.js";

interface RunNode {
  nodeId: string;
  title: string;
  state: string;
  waitingFor: { reason: string; detail?: string } | null;
  attempt: number | null;
  rovaraTaskUrl: string | null;
  pullRequests: Array<{ number: number; url: string; state: string }>;
}
interface RunView {
  runId: string;
  dagId: string;
  state: string;
  concurrencyLimit: number;
  costLimitUsd: number;
  costUsd: number;
  counts: Record<string, number>;
  actingFor: string;
  startedAt: string;
  nodes?: RunNode[];
}

const int = (name: string) => (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new CliFailure(EXIT.usage, `${name} must be a whole number`);
  return n;
};

const counts = (c: Record<string, number>) =>
  Object.entries(c)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${s} ${n}`)
    .join(", ");

/** run start | list | status (contracts/cli.md). */
export function register(program: Command, ctx: () => CliContext): void {
  const run = program.command("run").description("Start and inspect runs");

  run
    .command("start <dagId>")
    .description("Start a run of a DAG")
    .addOption(new Option("--concurrency <n>", "most nodes running at once").argParser(int("--concurrency")).makeOptionMandatory())
    .addOption(new Option("--cost-limit <usd>", "stop starting nodes at this cost").argParser(Number).makeOptionMandatory())
    .option("--attempts <n>", "attempts per node", int("--attempts"))
    .option("--fix-requests <n>", "fix requests per attempt", int("--fix-requests"))
    .option("--pr-updates <n>", "pull request updates per node", int("--pr-updates"))
    .option("--review-rounds <n>", "review rounds per node", int("--review-rounds"))
    .option("--quiet-minutes <n>", "minutes without news before a node is checked", int("--quiet-minutes"))
    .action(async (dagId: string, o: { concurrency: number; costLimit: number; attempts?: number; fixRequests?: number; prUpdates?: number; reviewRounds?: number; quietMinutes?: number }) => {
      const c = ctx();
      const retry = Object.fromEntries(
        Object.entries({ attempts: o.attempts, fixRequests: o.fixRequests, prUpdates: o.prUpdates, reviewRounds: o.reviewRounds, quietMinutes: o.quietMinutes }).filter(([, v]) => v !== undefined),
      );
      const body = { dagId, concurrencyLimit: o.concurrency, costLimitUsd: o.costLimit, ...(Object.keys(retry).length ? { retry } : {}) };
      const r = await c.api.request("POST", "/v1/runs", body);
      const link = (r.body as { error?: { linkUrl?: string } } | null)?.error?.linkUrl;
      if (link) throw new CliFailure(EXIT.refused, `Link your Rovara sign-in to the orchestrator first: ${link}`);
      const started = expectOk(r) as { runId: string; pageUrl?: string };
      print(c, started, () => [`Started ${started.runId}.`, ...(started.pageUrl ? [`Status page: ${started.pageUrl}`] : [])]);
    });

  run
    .command("list")
    .option("--state <state>", "only runs in this state")
    .description("List runs")
    .action(async (o: { state?: string }) => {
      const c = ctx();
      const r = expectOk(await c.api.request("GET", `/v1/runs${o.state ? `?state=${encodeURIComponent(o.state)}` : ""}`)) as { items: RunView[] };
      print(c, r, () => (r.items.length ? r.items.map((x) => `${x.runId}  ${x.state}  ${x.dagId}  ${counts(x.counts)}  $${x.costUsd.toFixed(2)}`) : ["No runs."]));
    });

  run
    .command("status <runId>")
    .description("Show a run's counts, cost and nodes")
    .action(async (runId: string) => {
      const c = ctx();
      const r = expectOk(await c.api.request("GET", `/v1/runs/${encodeURIComponent(runId)}`)) as RunView;
      print(c, r, () => [
        `${r.runId}  ${r.state}  ${r.dagId}  acting for ${r.actingFor}`,
        `Nodes: ${counts(r.counts) || "none"}`,
        `Cost: $${r.costUsd.toFixed(2)} of $${r.costLimitUsd}`,
        ...(r.nodes ?? []).map((n) => {
          const wait = n.waitingFor ? `  waiting: ${n.waitingFor.reason}${n.waitingFor.detail ? ` (${n.waitingFor.detail})` : ""}` : "";
          const prs = n.pullRequests.map((p) => `  ${p.url} (${p.state})`).join("");
          return `  ${n.nodeId}  ${n.state}${wait}${prs}`;
        }),
      ]);
    });
}
