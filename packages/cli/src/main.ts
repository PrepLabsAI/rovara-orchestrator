import { Command, CommanderError } from "commander";
import { HttpApi, KeychainTokenStore, Unreachable, type Api, type TokenStore } from "./client.js";
import { CliFailure, EXIT, type CliContext, type Output } from "./context.js";
import { register as auth } from "./commands/auth.js";
import { register as dag } from "./commands/dag.js";
import { register as nodeRead } from "./commands/node-read.js";
import { register as node } from "./commands/node.js";
import { register as repo } from "./commands/repo.js";
import { register as runControl } from "./commands/run-control.js";
import { register as run } from "./commands/run.js";
import { register as stop } from "./commands/stop.js";

export interface CliDeps {
  io?: Output;
  tokens?: TokenStore;
  /** Build the API client for a URL; tests pass a stub. */
  api?: (url: string, tokens: TokenStore) => Api;
  env?: Record<string, string | undefined>;
}

/** Run `rovara-orch` with `argv` (without node and script) and return the exit code. */
export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const io: Output = deps.io ?? { out: (l) => console.log(l), err: (l) => console.error(l) };
  const env = deps.env ?? process.env;
  // CI and scripts pass the token in the environment; it replaces the keychain and is never stored.
  const fromEnv = env.ROVARA_ORCH_TOKEN;
  const tokens: TokenStore = fromEnv ? { get: async () => fromEnv, set: async () => {}, delete: async () => {} } : (deps.tokens ?? new KeychainTokenStore());
  const program = new Command("rovara-orch")
    .description("Operate the Rovara DAG orchestrator")
    .option("--url <url>", "orchestrator URL", env.ROVARA_ORCH_URL)
    .option("--json", "print JSON")
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.out(s.trimEnd()), writeErr: (s) => io.err(s.trimEnd()) });

  let cached: CliContext | undefined;
  const ctx = (): CliContext => {
    if (cached) return cached;
    const opts = program.opts<{ url?: string; json?: boolean }>();
    if (!opts.url) throw new CliFailure(EXIT.usage, "set --url or ROVARA_ORCH_URL");
    const api = deps.api ? deps.api(opts.url, tokens) : new HttpApi(opts.url, () => tokens.get(opts.url!));
    cached = { api, tokens, io, url: opts.url, json: !!opts.json };
    return cached;
  };
  for (const r of [auth, dag, run, runControl, node, nodeRead, stop, repo]) r(program, ctx);

  try {
    await program.parseAsync(argv, { from: "user" });
    return EXIT.ok;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode === 0 ? EXIT.ok : EXIT.usage;
    if (e instanceof CliFailure) {
      io.err(e.message);
      return e.exitCode;
    }
    if (e instanceof Unreachable) {
      io.err(e.message);
      return EXIT.unreachable;
    }
    throw e;
  }
}
