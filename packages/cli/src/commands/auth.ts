import type { Command } from "commander";
import { CliFailure, EXIT, expectOk, print, type CliContext } from "../context.js";

/**
 * login / logout / whoami. Until Rovara can sign operators in to other services (Rovara#442),
 * `login --token` stores a development-identity token; the Rovara terminal flow replaces it.
 */
export function register(program: Command, ctx: () => CliContext): void {
  program
    .command("login")
    .description("Sign in and store the token in the OS keychain")
    .option("--token <token>", "a development-identity token (until Rovara sign-in for services exists)")
    .action(async (opts: { token?: string }) => {
      const c = ctx();
      if (!opts.token) {
        throw new CliFailure(EXIT.usage, "Rovara sign-in for the orchestrator is not available yet (PrepLabsAI/Rovara#442); use --token");
      }
      await c.tokens.set(c.url, opts.token);
      const me = expectOk(await c.api.request("GET", "/v1/me")) as { id: string; name: string };
      print(c, me, () => [`Signed in as ${me.name} (${me.id}).`]);
    });

  program
    .command("logout")
    .description("Remove the stored token")
    .action(async () => {
      const c = ctx();
      await c.tokens.delete(c.url);
      print(c, { signedOut: true }, () => ["Signed out."]);
    });

  program
    .command("whoami")
    .description("Show the signed-in operator and whether Rovara reports them as an administrator")
    .action(async () => {
      const c = ctx();
      const me = expectOk(await c.api.request("GET", "/v1/me")) as { id: string; name: string; isAdmin: boolean };
      print(c, me, () => [`${me.name} (${me.id})${me.isAdmin ? ", Rovara administrator" : ""}`]);
    });
}
