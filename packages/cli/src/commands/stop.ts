import { Option, type Command } from "commander";
import { expectOk, print, type CliContext } from "../context.js";

interface StopSwitch {
  on: boolean;
  by: string | null;
  at: string | null;
  reason: string | null;
}

/** stop on | off | status (FR-051). */
export function register(program: Command, ctx: () => CliContext): void {
  const stop = program.command("stop").description("The global stop switch: no starts, approvals or merges while on");
  for (const state of ["on", "off"] as const) {
    stop
      .command(state)
      .description(`Turn the stop switch ${state}`)
      .addOption(new Option("--reason <text>", "why (recorded with the decision)").makeOptionMandatory())
      .action(async (o: { reason: string }) => {
        const c = ctx();
        const r = expectOk(await c.api.request("PUT", "/v1/stop-switch", { on: state === "on", reason: o.reason })) as StopSwitch;
        print(c, r, () => [`The stop switch is ${r.on ? "on" : "off"}.`]);
      });
  }
  stop
    .command("status")
    .description("Show the stop switch")
    .action(async () => {
      const c = ctx();
      const r = expectOk(await c.api.request("GET", "/v1/stop-switch")) as StopSwitch;
      print(c, r, () => [r.on ? `The stop switch is on (by ${r.by} at ${r.at}: ${r.reason}).` : "The stop switch is off."]);
    });
}
