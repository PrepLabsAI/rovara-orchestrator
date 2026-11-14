import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";
import { signGithubBody } from "@rovara-orch/github";
import { sign } from "@rovara-orch/rovara";
import { FakeGithub } from "../fake-github.js";
import { FakeModel } from "../fake-model.js";
import { FakeRovara, type Behaviour } from "../fake-rovara.js";
import { FakeSlack } from "../fake-slack.js";

/**
 * The load stage's fake Rovara, GitHub, Slack and answering model, as one Lambda behind a function
 * URL (T121). The orchestrator's workers call it through `POST /rpc`; the load driver configures
 * and reads it through `POST /control`. Its state lives in one warm container (reserved
 * concurrency 1), so it is for load tests only, and its throughput bounds what a test can show.
 * Events and webhooks are delivered to the orchestrator's real routes, signed like the real ones.
 */
const github = new FakeGithub({ repo: process.env.FAKE_REPO ?? "acme/mono" });
const rovara = new FakeRovara(github, {});
const slack = new FakeSlack();
const model = new FakeModel();
const targets: Record<string, object> = { github, rovara, slack, model };

const config = { orchestratorUrl: process.env.ORCH_URL ?? "" };
const outbox: Array<() => Promise<void>> = [];
let delivery = 0;
let secrets: Promise<{ rovara: string; github: string }> | undefined;

async function readSecrets() {
  secrets ??= (async () => {
    const sm = new SecretsManagerClient({});
    const read = async (env: string) => (await sm.send(new GetSecretValueCommand({ SecretId: process.env[env]! }))).SecretString ?? "";
    return { rovara: await read("ROVARA_SECRET_ARN"), github: await read("GITHUB_WEBHOOK_SECRET_ARN") };
  })();
  return secrets;
}

rovara.onEvent((e) =>
  outbox.push(async () => {
    const body = JSON.stringify(e.body);
    const s = await readSecrets();
    await fetch(`${config.orchestratorUrl}/rovara/events`, { method: "POST", headers: { "content-type": "application/json", ...sign(s.rovara, e.id, new Date(), body) }, body });
  }),
);
github.onWebhook((w) =>
  outbox.push(async () => {
    const body = JSON.stringify(w.payload);
    const s = await readSecrets();
    await fetch(`${config.orchestratorUrl}/github/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": w.event, "x-github-delivery": `load-${++delivery}`, "x-hub-signature-256": signGithubBody(s.github, body) },
      body,
    });
  }),
);

async function flush(): Promise<void> {
  while (outbox.length) await outbox.shift()!();
}

const control: Record<string, (...args: never[]) => unknown> = {
  configure: (c: { orchestratorUrl: string }) => void (config.orchestratorUrl = c.orchestratorUrl.replace(/\/$/, "")),
  setBehaviour: (nodeId: string, b: Behaviour) => rovara.setBehaviour(nodeId, b),
  stats: () => ({
    conversations: rovara.conversations.size,
    duplicateRequests: rovara.duplicateRequests.length,
    pulls: github.pulls.size,
    merges: github.merges.length,
    mergedNodes: [...github.pulls.values()].filter((p) => p.state === "merged").map((p) => p.headRef),
    slackPosts: slack.posts.length,
  }),
};

const json = (statusCode: number, body: unknown): LambdaFunctionURLResult => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  if (event.headers["x-load-secret"] !== process.env.FAKE_SERVICES_SECRET) return json(403, { error: { message: "wrong load secret" } });
  const req = JSON.parse(event.body ?? "{}") as { target?: string; method: string; args?: unknown[] };
  const path = event.rawPath;
  try {
    let result: unknown;
    if (path === "/control") {
      const fn = control[req.method];
      if (!fn) return json(404, { error: { message: `no control ${req.method}` } });
      result = await (fn as (...a: unknown[]) => unknown)(...(req.args ?? []));
    } else if (path === "/rpc") {
      const target = targets[req.target ?? ""] as Record<string, unknown> | undefined;
      const fn = target?.[req.method];
      if (typeof fn !== "function") return json(404, { error: { message: `no ${req.target}.${req.method}` } });
      result = await (fn as (...a: unknown[]) => unknown).apply(target, req.args ?? []);
    } else {
      return json(404, { error: { message: `no route ${path}` } });
    }
    await flush();
    return json(200, { result: result ?? null });
  } catch (e) {
    await flush();
    const err = e as Error & { retryAfterSeconds?: number; userId?: string };
    return json(200, { error: { name: err.name, message: err.message, userId: err.userId ?? null } });
  }
}
