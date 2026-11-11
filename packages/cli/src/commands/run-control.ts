import { randomUUID } from "node:crypto";
import { Option, type Command } from "commander";
import { expectOk, print, type CliContext } from "../context.js";

/** run pause | resume | cancel | take-over <runId> --reason (FR-050, FR-057). */
export function register(program: Command, ctx: () => CliContext): void {
  const run = program.commands.find((c) => c.name() === "run") ?? program.command("run");
  const what = { pause: "Pause a run", resume: "Resume a run", cancel: "Cancel a run", "take-over": "Act for this run as yourself from now on" };
  for (const action of ["pause", "resume", "cancel", "take-over"] as const) {
    run
      .command(`${action} <runId>`)
      .description(what[action])
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
