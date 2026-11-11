import { randomUUID } from "node:crypto";
import { Option, type Command } from "commander";
import { expectOk, print, type CliContext } from "../context.js";

/** run pause | resume | cancel <runId> --reason (FR-050). Take-over is added by US5. */
export function register(program: Command, ctx: () => CliContext): void {
  const run = program.commands.find((c) => c.name() === "run") ?? program.command("run");
  for (const action of ["pause", "resume", "cancel"] as const) {
    run
      .command(`${action} <runId>`)
      .description(`${action[0]!.toUpperCase()}${action.slice(1)} a run`)
      .addOption(new Option("--reason <text>", "why (recorded with the decision)").makeOptionMandatory())
      .action(async (runId: string, o: { reason: string }) => {
        const c = ctx();
        const r = expectOk(
          await c.api.request("POST", `/v1/runs/${encodeURIComponent(runId)}/${action}`, { reason: o.reason }, { idempotencyKey: randomUUID() }),
        ) as { decisionId: string };
        print(c, r, () => [`${action} of ${runId} recorded (${r.decisionId}); it applies in a moment.`]);
      });
  }
}
