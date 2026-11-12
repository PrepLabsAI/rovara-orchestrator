import { describe, expect, test } from "vitest";
import { Answerer } from "@rovara-orch/answerer";
import { GithubAppApi } from "@rovara-orch/github";
import { ChannelClient } from "@rovara-orch/rovara";
import { SlackNotifier } from "@rovara-orch/slack";
import { buildClients } from "./clients.js";

const secrets: Record<string, string> = {
  ROVARA_SECRET_ARN: "whsec_" + Buffer.from("x".repeat(32)).toString("base64"),
  GITHUB_APP_KEY_ARN: "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----",
  SLACK_TOKEN_ARN: "xoxb-test",
};
const secret = async (name: string) => secrets[name] ?? Promise.reject(new Error(`no ${name}`));
const base = { STAGE: "test", AWS_REGION: "us-east-1", ROVARA_URL: "https://rovara.test", ROVARA_CHANNEL: "orchestrator", GITHUB_APP_ID: "123", GITHUB_INSTALLATION_ID: "456" };

describe("the deployed functions' clients (T130)", () => {
  test("outside the load stage: Rovara's channel API, the GitHub App, Slack and the answerer on Bedrock", async () => {
    const c = await buildClients(base, secret);
    expect(c.rovara).toBeInstanceOf(ChannelClient);
    expect(c.github).toBeInstanceOf(GithubAppApi);
    expect(c.slack).toBeInstanceOf(SlackNotifier);
    expect(c.answerer).toBeInstanceOf(Answerer);
  });

  test("a missing GitHub App id is a clear error, not a placeholder", async () => {
    await expect(buildClients({ ...base, GITHUB_APP_ID: undefined }, secret)).rejects.toThrow(/GITHUB_APP_ID/);
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
