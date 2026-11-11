import { describe, expect, test } from "vitest";
import { MemoryTokenStore, Unreachable, type Api } from "../client.js";
import { runCli } from "../main.js";

function setup(respond: (method: string, path: string) => { status: number; body: unknown } | Error) {
  const lines: string[] = [];
  const errors: string[] = [];
  const tokens = new MemoryTokenStore();
  const api: Api = {
    request: async (method, path) => {
      const r = respond(method, path);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  const run = (...argv: string[]) =>
    runCli(["--url", "https://orch.test", ...argv], { io: { out: (l) => lines.push(l), err: (l) => errors.push(l) }, tokens, api: () => api });
  return { run, lines, errors, tokens };
}

const me = { status: 200, body: { id: "dev_alice", name: "Alice", isAdmin: true } };

describe("rovara-orch frame", () => {
  test("login --token stores the token and greets the operator", async () => {
    const t = setup(() => me);
    expect(await t.run("login", "--token", "dev.x.y")).toBe(0);
    expect(await t.tokens.get("https://orch.test")).toBe("dev.x.y");
    expect(t.lines).toEqual(["Signed in as Alice (dev_alice)."]);
  });

  test("whoami prints readable text, or JSON with --json", async () => {
    const t = setup(() => me);
    expect(await t.run("whoami")).toBe(0);
    expect(t.lines.at(-1)).toBe("Alice (dev_alice), Rovara administrator");
    expect(await t.run("--json", "whoami")).toBe(0);
    expect(JSON.parse(t.lines.at(-1)!)).toEqual(me.body);
  });

  test("exit codes: 1 refused, 2 usage, 3 unreachable", async () => {
    expect(await setup(() => ({ status: 401, body: { error: { code: "AUTH_REQUIRED", message: "sign in" } } })).run("whoami")).toBe(1);
    expect(await setup(() => me).run("no-such-command")).toBe(2);
    expect(await setup(() => me).run("login")).toBe(2);
    expect(await setup(() => new Unreachable("down")).run("whoami")).toBe(3);
    expect(await runCli(["whoami"], { io: { out: () => {}, err: () => {} }, tokens: new MemoryTokenStore(), env: {} })).toBe(2);
  });

  test("logout removes the token", async () => {
    const t = setup(() => me);
    await t.tokens.set("https://orch.test", "tok");
    expect(await t.run("logout")).toBe(0);
    expect(await t.tokens.get("https://orch.test")).toBeNull();
  });
});
