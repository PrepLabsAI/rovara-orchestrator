import { readFileSync } from "node:fs";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { afterEach, describe, expect, test } from "vitest";
import { signGithubBody } from "@rovara-orch/github";
import { newSecret, sign } from "@rovara-orch/rovara";
import { createHarness, type Harness } from "@rovara-orch/testkit";
import { handleGithubEvent, handleRovaraEvent } from "@rovara-orch/workers";
import { DataStack } from "../../infra/lib/data.js";
import { ServiceStack } from "../../infra/lib/service.js";
import { stageConfig } from "../../infra/lib/stage.js";

let h: Harness | undefined;
afterEach(async () => h?.drop());

async function withAttempt() {
  h = await createHarness({ name: "security" });
  const runId = await h.startRun(await h.seedDag([{ nodeId: "US1", files: ["a.ts"] }]), { concurrency: 1 });
  await h.runUntil(async () => !!(await h!.repos.getRunNode(runId, "US1"))?.currentAttempt);
  const attemptId = (await h.repos.getRunNode(runId, "US1"))!.currentAttempt!;
  const attempt = (await h.repos.getAttempt(attemptId))!;
  return { h, attempt };
}

const rovaraEvent = (conversation: { tenant: string; space: string; thread: string }, id = "evt_security00000000000001", channel = "orchestrator") =>
  JSON.stringify({ version: 1, id, channel, conversation: { ...conversation, channel }, createdAt: new Date().toISOString(), type: "progress", data: { text: "working" } });

describe("both ingresses refuse what they must (T124)", () => {
  test("Rovara: a bad signature, a stale timestamp and a wrong channel are refused; a replayed event id changes nothing", async () => {
    const { h, attempt } = await withAttempt();
    const body = rovaraEvent(attempt.conversation);
    const ok: Record<string, string> = { ...sign(h.rovaraSecret, "evt_security00000000000001", h.clock.now(), body) };
    expect((await handleRovaraEvent(h.deps, h.rovaraSecret, { headers: { ...sign(newSecret(), "evt_security00000000000001", h.clock.now(), body) }, body })).status).toBe(401);
    expect((await handleRovaraEvent(h.deps, h.rovaraSecret, { headers: { ...ok, "webhook-signature": ok["webhook-signature"]!.replace(/.$/, "A") }, body })).status).toBe(401);
    const stale = { ...sign(h.rovaraSecret, "evt_security00000000000001", new Date(h.clock.now().getTime() - 6 * 60_000), body) };
    expect((await handleRovaraEvent(h.deps, h.rovaraSecret, { headers: stale, body })).status).toBe(401);
    const wrong = rovaraEvent(attempt.conversation, "evt_security00000000000002", "slack");
    expect((await handleRovaraEvent(h.deps, h.rovaraSecret, { headers: { ...sign(h.rovaraSecret, "evt_security00000000000002", h.clock.now(), wrong) }, body: wrong })).status).toBe(403);

    expect(await handleRovaraEvent(h.deps, h.rovaraSecret, { headers: ok, body })).toEqual({ status: 200, body: "ok" });
    expect(await handleRovaraEvent(h.deps, h.rovaraSecret, { headers: ok, body })).toEqual({ status: 200, body: "duplicate" });
    const stored = await h.table.query<{ event: { id: string } }>(`ATT#${attempt.attemptId}`, "EV#");
    expect(stored.filter((e) => e.event.id === "evt_security00000000000001")).toHaveLength(1);
  });

  test("GitHub: a bad or missing signature is refused; a replayed delivery id changes nothing", async () => {
    const { h } = await withAttempt();
    const body = JSON.stringify({ ref: "refs/heads/main", after: "2".repeat(40), repository: { full_name: "acme/mono" } });
    const headers = (sig: string | undefined, delivery = "d-sec-1") => ({ "x-github-event": "push", "x-github-delivery": delivery, ...(sig ? { "x-hub-signature-256": sig } : {}) });
    expect((await handleGithubEvent(h.deps, h.githubSecret, { headers: headers(undefined), body })).status).toBe(401);
    expect((await handleGithubEvent(h.deps, h.githubSecret, { headers: headers(signGithubBody("not-the-secret", body)), body })).status).toBe(401);
    expect((await handleGithubEvent(h.deps, h.githubSecret, { headers: headers(signGithubBody(h.githubSecret, body)), body: body + " " })).status).toBe(401);
    expect((await handleGithubEvent(h.deps, h.githubSecret, { headers: headers(signGithubBody(h.githubSecret, body)), body })).body).toBe("ok");
    expect((await handleGithubEvent(h.deps, h.githubSecret, { headers: headers(signGithubBody(h.githubSecret, body)), body })).body).toBe("duplicate");
  });
});

describe("least privilege (T124)", () => {
  type Statement = { Action: string | string[]; Resource: unknown };
  function policies() {
    const app = new App({ context: { "aws:cdk:bundling-stacks": [] } });
    const stage = stageConfig("prod");
    const data = new DataStack(app, "Data", { stage });
    const t = Template.fromStack(new ServiceStack(app, "Service", { stage, data }));
    const fns = t.findResources("AWS::Lambda::Function") as Record<string, { Properties: { Role: { "Fn::GetAtt": [string, string] }; Environment: { Variables: { ROVARA_ORCH_ROLE: string } } } }>;
    const roleOf = new Map(Object.values(fns).map((f) => [f.Properties.Role["Fn::GetAtt"][0], f.Properties.Environment.Variables.ROVARA_ORCH_ROLE]));
    const byRole = new Map<string, Statement[]>();
    for (const p of Object.values(t.findResources("AWS::IAM::Policy")) as Array<{ Properties: { Roles: Array<{ Ref: string }>; PolicyDocument: { Statement: Statement[] } } }>) {
      for (const r of p.Properties.Roles) {
        const role = roleOf.get(r.Ref);
        if (role) byRole.set(role, [...(byRole.get(role) ?? []), ...p.Properties.PolicyDocument.Statement]);
      }
    }
    return byRole;
  }
  const actions = (s: Statement[]) => s.flatMap((x) => (Array.isArray(x.Action) ? x.Action : [x.Action]));
  const secretReads = (s: Statement[]) => s.filter((x) => actions([x]).includes("secretsmanager:GetSecretValue")).map((x) => JSON.stringify(x.Resource));

  test("no function has a wildcard action", () => {
    for (const [role, s] of policies()) {
      expect(actions(s).filter((a) => a === "*" || a.endsWith(":*")), role).toEqual([]);
    }
  });

  test.each([
    ["rovara-ingress", ["RovaraAdapterSecret"]],
    ["github-ingress", ["GithubWebhookSecret", "GithubAppPrivateKey"]],
    ["api", ["RovaraAdapterSecret", "GithubAppPrivateKey"]],
    ["work-consumer", ["GithubAppPrivateKey"]],
    ["intent-runner", ["RovaraAdapterSecret", "GithubAppPrivateKey", "SlackToken"]],
    ["sweep", ["RovaraAdapterSecret", "GithubAppPrivateKey", "SlackToken"]],
  ])("%s reads only the secrets it uses", (role, expected) => {
    const reads = secretReads(policies().get(role)!);
    expect(reads).toHaveLength(expected.length);
    for (const e of expected) expect(reads.some((r) => r.includes(e)), `${role} reads ${e}`).toBe(true);
  });

  test("only the intent runner and the sweep may call the model or send to the queue; only the API reaches the DAG bucket", () => {
    for (const [role, s] of policies()) {
      const a = actions(s);
      expect(a.some((x) => x.startsWith("bedrock:")), `${role} bedrock`).toBe(role === "intent-runner" || role === "sweep");
      expect(a.includes("sqs:SendMessage"), `${role} sqs send`).toBe(role === "intent-runner" || role === "sweep");
      expect(a.some((x) => x.startsWith("s3:")), `${role} s3`).toBe(role === "api");
    }
  });

  test("the GitHub App asks for exactly the contract's permissions and events", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../infra/github-app-manifest.json", import.meta.url), "utf8"));
    expect(manifest.default_permissions).toEqual({ metadata: "read", contents: "write", pull_requests: "write", checks: "read", statuses: "read" });
    expect([...manifest.default_events].sort()).toEqual(["check_run", "check_suite", "merge_group", "pull_request", "pull_request_review", "pull_request_review_comment", "pull_request_review_thread", "push", "status"]);
    expect(manifest.public).toBe(false);
  });
});
