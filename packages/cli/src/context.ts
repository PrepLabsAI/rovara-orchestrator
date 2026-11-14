import type { Api, ApiResult, TokenStore } from "./client.js";

/** Exit codes (contracts/cli.md). */
export const EXIT = { ok: 0, refused: 1, usage: 2, unreachable: 3 } as const;

export class CliFailure extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
    this.name = "CliFailure";
  }
}

export interface Output {
  out(line: string): void;
  err(line: string): void;
}

/** What every command gets: the API, the token store, the output, and global options. */
export interface CliContext {
  api: Api;
  tokens: TokenStore;
  io: Output;
  url: string;
  json: boolean;
}

/** Print JSON with --json, otherwise the readable lines. */
export function print(ctx: CliContext, value: unknown, lines: () => string[]): void {
  if (ctx.json) ctx.io.out(JSON.stringify(value, null, 2));
  else for (const l of lines()) ctx.io.out(l);
}

/** Turn a 4xx answer into a refusal with the API's message. */
export function expectOk(r: ApiResult, okStatuses: number[] = [200, 201, 202]): unknown {
  if (okStatuses.includes(r.status)) return r.body;
  const err = (r.body as { error?: { code?: string; message?: string; problem?: string } } | null)?.error;
  const detail = err?.problem ? ` (${err.problem})` : "";
  throw new CliFailure(EXIT.refused, `${err?.code ?? r.status}: ${err?.message ?? "refused"}${detail}`);
}
