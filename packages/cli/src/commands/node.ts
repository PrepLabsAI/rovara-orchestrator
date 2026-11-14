import { randomUUID } from "node:crypto";
import { Option, type Command } from "commander";
import { expectOk, print, type CliContext } from "../context.js";

/** node retry | skip | cancel <runId> <nodeId> --reason (FR-033). */
export function register(program: Command, ctx: () => CliContext): void {
  const node = program.commands.find((c) => c.name() === "node") ?? program.command("node").description("Act on a run's nodes");
  const what = { retry: "Retry an escalated node with a fresh set of attempts", skip: "Mark an escalated node done without a merge", cancel: "Cancel an escalated node" };
  for (const action of ["retry", "skip", "cancel"] as const) {
    node
      .command(`${action} <runId> <nodeId>`)
      .description(what[action])
      .addOption(new Option("--reason <text>", "why (recorded with the decision)").makeOptionMandatory())
      .action(async (runId: string, nodeId: string, o: { reason: string }) => {
        const c = ctx();
        const path = `/v1/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/${action}`;
        const r = expectOk(await c.api.request("POST", path, { reason: o.reason }, { idempotencyKey: randomUUID() })) as { decisionId: string };
        print(c, r, () => [`${action} of ${nodeId} recorded (${r.decisionId}); it applies in a moment.`]);
      });
  }
}
