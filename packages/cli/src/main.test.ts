import { describe, expect, test } from "vitest";
import type { Api, TokenStore } from "./client.js";
import { runCli } from "./main.js";

describe("rovara-orch token from the environment", () => {
  test("ROVARA_ORCH_TOKEN is used instead of the keychain, for CI and scripts, and never stored", async () => {
    let seen: string | null = null;
    let stored = false;
    const keychain: TokenStore = { get: async () => "from-keychain", set: async () => void (stored = true), delete: async () => {} };
    const api = (url: string, tokens: TokenStore): Api => ({
      request: async () => {
        seen = await tokens.get(url);
        return { status: 200, body: { on: false, by: null, at: null, reason: null } };
      },
    });
    const code = await runCli(["--url", "https://orch.test", "stop", "status"], { io: { out: () => {}, err: () => {} }, tokens: keychain, api, env: { ROVARA_ORCH_TOKEN: "dev.ci.abc" } });
    expect(code).toBe(0);
    expect(seen).toBe("dev.ci.abc");
    expect(stored).toBe(false);
  });
});
