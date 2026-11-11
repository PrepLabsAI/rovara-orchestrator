import { MemoryTokenStore, type Api } from "../client.js";
import { runCli } from "../main.js";

/** Run `rovara-orch` against a stub API, recording requests and output. */
export function cliHarness(respond: (method: string, path: string, body?: unknown) => { status: number; body: unknown }) {
  const lines: string[] = [];
  const errors: string[] = [];
  const calls: Array<{ method: string; path: string; body?: unknown; idempotencyKey?: string }> = [];
  const api: Api = {
    request: async (method, path, body, opts) => {
      calls.push({ method, path, body, ...(opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}) });
      return respond(method, path, body);
    },
  };
  const run = (...argv: string[]) =>
    runCli(["--url", "https://orch.test", ...argv], { io: { out: (l) => lines.push(l), err: (l) => errors.push(l) }, tokens: new MemoryTokenStore(), api: () => api });
  return { run, lines, errors, calls };
}
