import type { Command } from "commander";
import { expectOk, print, type CliContext } from "../context.js";

interface NodeView {
  pageUrl?: string;
  nodeId: string;
  title: string;
  state: string;
  waitingFor: { reason: string; detail?: string } | null;
  attempts: Array<{
    n: number;
    phase: string;
    rovaraTaskUrl: string | null;
    pullRequests: Array<{ number: number; url: string; state: string }>;
    questions: Array<{ question: string; answer: string; answeredBy: string }>;
    reviewComments: Array<{ path: string | null; line: number | null; body: string; resolution?: string | null }>;
    checkReports: Array<{ status: string }>;
  }>;
  decisions: Array<{ at: string; actor: string; action: string; reason: string }>;
}

/** node show <runId> <nodeId>: one node's attempts, PRs, questions, review comments and decisions. The trace is on the node page. */
export function register(program: Command, ctx: () => CliContext): void {
  const node = program.commands.find((c) => c.name() === "node") ?? program.command("node").description("Act on a run's nodes");
  node
    .command("show <runId> <nodeId>")
    .description("Show one node: attempts, PRs, questions, review comments and decisions")
    .action(async (runId: string, nodeId: string) => {
      const c = ctx();
      const v = expectOk(await c.api.request("GET", `/v1/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}`)) as NodeView;
      const page = v.pageUrl ?? "the status page";
      print(c, v, () => [
        `${v.nodeId}  ${v.title}  ${v.state}${v.waitingFor ? `  waiting: ${v.waitingFor.reason}${v.waitingFor.detail ? ` (${v.waitingFor.detail})` : ""}` : ""}`,
        ...v.attempts.flatMap((a) => [
          `Attempt ${a.n}: ${a.phase}${a.checkReports.length ? `, checks ${a.checkReports.at(-1)!.status}` : ""}${a.rovaraTaskUrl ? `  ${a.rovaraTaskUrl}` : ""}`,
          ...a.pullRequests.map((p) => `  PR #${p.number} (${p.state}) ${p.url}`),
          ...a.questions.map((q) => `  Q: ${q.question}\n  A: ${q.answer}  (${q.answeredBy})`),
          ...a.reviewComments.map((r) => `  Review ${r.path ?? "?"}:${r.line ?? "?"} ${r.body}${r.resolution ? ` [${r.resolution}]` : ""}`),
        ]),
        "Decisions:",
        ...v.decisions.map((d) => `  ${d.at}  ${d.actor}  ${d.action}: ${d.reason}`),
        `The trace is on the node page: ${page}`,
      ]);
    });
}
