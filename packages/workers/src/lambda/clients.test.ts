import { describe, expect, test } from "vitest";
import { Answerer } from "@rovara-orch/answerer";
import { GithubAppApi } from "@rovara-orch/github";
import { ChannelClient } from "@rovara-orch/rovara";
import { SlackNotifier } from "@rovara-orch/slack";
import { buildClients, connectors } from "./clients.js";

const secrets: Record<string, string> = {
  ROVARA_SECRET_ARN: "whsec_" + Buffer.from("x".repeat(32)).toString("base64"),
  GITHUB_APP_KEY_ARN: "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----",
  SLACK_TOKEN_ARN: "xoxb-test",
};
const secret = async (name: string) => secrets[name] ?? Promise.reject(new Error(`no ${name}`));
const base = { STAGE: "test", AWS_REGION: "us-east-1", ROVARA_URL: "https://rovara.test", ROVARA_CHANNEL: "orchestrator", GITHUB_APP_ID: "123", GITHUB_INSTALLATION_ID: "456" };

describe("the deployed functions' clients (T130)", () => {
  test("outside the load stage: Rovara's channel API, the GitHub App, Slack and the answerer on Bedrock", async () => {
    const c = connectors(base, secret);
    expect(await c.rovara()).toBeInstanceOf(ChannelClient);
    expect(await c.github()).toBeInstanceOf(GithubAppApi);
    expect(await c.slack()).toBeInstanceOf(SlackNotifier);
    expect(await c.answerer()).toBeInstanceOf(Answerer);
  });

  test("each secret is read only when its client is first used: a function may read only the secrets it needs", async () => {
    const read: string[] = [];
    const recording = async (name: string) => (read.push(name), secret(name));
    const c = await buildClients(base, recording);
    expect(read).toEqual([]);
    // A function without the Slack token can still be built and use GitHub.
    const noSlack = await buildClients(base, async (n) => (n === "SLACK_TOKEN_ARN" ? Promise.reject(new Error("AccessDenied")) : recording(n)));
    await expect(noSlack.slack.post({ channel: "C", text: "t", key: "k" })).rejects.toThrow(/AccessDenied/);
    expect(c).toBeDefined();
    const conn = connectors(base, recording);
    await conn.github();
    expect(read).toEqual(["GITHUB_APP_KEY_ARN"]);
  });

  test("a missing GitHub App id is a clear error, not a placeholder", async () => {
    await expect(connectors({ ...base, GITHUB_APP_ID: undefined }, secret).github()).rejects.toThrow(/GITHUB_APP_ID/);
  });

  test("the fake services are used only in the load stage", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ result: "main-sha" }), { status: 200 });
    }) as unknown as typeof fetch;
    const load = await buildClients({ ...base, STAGE: "load", FAKE_SERVICES_URL: "https://fakes.test/", FAKE_SERVICES_SECRET: "s" }, secret, fetchFn);
    expect(await load.github.mainHead("acme/mono")).toBe("main-sha");
    expect(calls).toEqual([{ url: "https://fakes.test/rpc", body: { target: "github", method: "mainHead", args: ["acme/mono"] } }]);
    await expect(buildClients({ ...base, STAGE: "prod", FAKE_SERVICES_URL: "https://fakes.test/" }, secret)).rejects.toThrow(/only in the load stage/);
  });
});
