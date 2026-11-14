import { afterEach, describe, expect, test } from "vitest";
import { handle, type ApiDeps } from "@rovara-orch/api";
import { DevIdentity } from "@rovara-orch/identity";
import { createHarness, SOME_FAULTS, type Harness, type HarnessOptions } from "@rovara-orch/testkit";

let open: Harness[] = [];
afterEach(async () => {
  await Promise.all(open.map((h) => h.drop()));
  open = [];
});

const NODES = [
  { nodeId: "foundational", kind: "foundational", files: ["src/db.ts"] },
  { nodeId: "US1", dependsOn: ["foundational"], files: ["src/signup.ts"] },
];

/** The operator API over the harness's store: dev_op is an operator, dev_eve is signed in but is not. */
async function api(h: Harness) {
  const identity = new DevIdentity({ stage: "test", signingKey: "k", operators: [{ id: "dev_op", name: "Op", admin: false }, { id: "dev_eve", name: "Eve", admin: false }] });
  const access = identity.access.bind(identity);
  identity.access = async (op) => (op.id === "dev_eve" ? { isOperator: false, isAdmin: false } : access(op));
  const deps: ApiDeps = {
    table: h.table,
    repos: h.repos,
    identity,
    clock: h.clock,
    github: { commitOnRemote: async () => true },
    rovara: { linkUrl: async () => null, isLinked: async () => true },
    config: { statusPageUrl: "https://status.test" },
  };
  const tokens = { op: (await identity.login("dev_op")).token, eve: (await identity.login("dev_eve")).token };
  const get = async (path: string, who: "op" | "eve" = "op") => {
    const [p, q] = path.split("?");
    const query = Object.fromEntries(new URLSearchParams(q ?? ""));
    return handle(deps, { method: "GET", path: p!, headers: { Authorization: `Bearer ${tokens[who]}` }, query, body: undefined });
  };
  return { get };
}

async function harness(opts: HarnessOptions = {}) {
  const h = await createHarness({ name: "status", ...opts });
  open.push(h);
  const runId = await h.startRun(await h.seedDag(NODES), { concurrency: 2 });
  return { h, runId, ...(await api(h)) };
}

interface Step { sequence: number; at: string; kind: string; payload: unknown }

describe("status API (US5)", () => {
  test("a non-operator is refused, and the refusal is recorded", async () => {
    const { h, runId, get } = await harness();
    const r = await get(`/v1/runs/${runId}`, "eve");
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: { code: "NOT_OPERATOR" } });
    const refusals = (await h.table.query<Record<string, unknown>>("DECISIONS#GLOBAL", "DEC#")).filter((d) => d.action === "refused");
    expect(refusals).toEqual([expect.objectContaining({ actor: "dev_eve" })]);
  });

  test("trace reads after a cursor return each step once and in order, also with repeated deliveries, and after the workspace closed (SC-010)", async () => {
    const { h, runId, get } = await harness({ seed: 41, faults: SOME_FAULTS });
    expect(await h.runToEnd(runId, { maxSteps: 4000, maxIdle: 60 })).toBe(true);
    expect(await h.runUntil(() => h.settled())).toBe(true); // the last events (the workspace closing) are in
    // US1's workspace was closed after its merge; its trace is still there.
    expect(h.rovara.attemptsFor("US1")[0]!.received.some((r) => r.text === "close this workspace")).toBe(true);

    const seen: Step[] = [];
    let after: number | null = null;
    let live = true;
    for (let page = 0; page < 50; page++) {
      const r = await get(`/v1/runs/${runId}/nodes/US1/trace?limit=3${after === null ? "" : `&after=${after}`}`);
      expect(r.status).toBe(200);
      const body = r.body as { steps: Step[]; next: number | null; live: boolean };
      seen.push(...body.steps);
      live = body.live;
      if (body.next === null) break;
      after = body.next;
    }
    expect(live).toBe(false);
    const sequences = seen.map((s) => s.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(sequences[0]).toBe(1);
    expect(sequences.at(-1)).toBe(sequences.length);
    expect(new Set(seen.map((s) => s.kind))).toEqual(new Set(["progress", "check_report", "pr", "message"]));
    // Exactly one step per stored event of those kinds, however often Rovara delivered it.
    const events = (await h.table.query<{ event: { id: string; type: string } }>(`ATT#${(await h.repos.getRunNode(runId, "US1"))!.currentAttempt}`, "EV#"))
      .filter((e) => ["progress", "message", "check_report", "pr"].includes(e.event.type));
    expect(seen).toHaveLength(events.length);
  });

  test("trace items get expiresAt = endedAt + 90 days within one sweep of the run ending, and have none before", async () => {
    const { h, runId } = await harness({ seed: 42 });
    const attemptOf = async (id: string) => (await h.repos.getRunNode(runId, id))!.currentAttempt!;
    expect(await h.runUntil(async () => (await h.repos.getRunNode(runId, "foundational"))!.state === "merged")).toBe(true);
    const before = await h.table.query<{ expiresAt?: number }>(`TRACE#${await attemptOf("foundational")}`, "");
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((s) => s.expiresAt === undefined)).toBe(true);

    expect(await h.runToEnd(runId)).toBe(true);
    await h.idle(); // one sweep
    const run = (await h.repos.getRun(runId))!;
    expect(run.tracesExpireSetAt).not.toBeNull();
    const expected = Math.floor(new Date(run.endedAt!).getTime() / 1000) + 90 * 24 * 3600;
    for (const id of ["foundational", "US1"]) {
      const steps = await h.table.query<{ expiresAt?: number }>(`TRACE#${await attemptOf(id)}`, "");
      expect(steps.length).toBeGreaterThan(0);
      expect(steps.every((s) => s.expiresAt === expected), id).toBe(true);
    }
  });

  test("run and node reads return the contract's fields, including the Rovara task link and notifications not yet delivered", async () => {
    // US1 asks for an administrator, so it escalates; Slack has no channel, so that message stays undelivered.
    const { h, runId, get } = await harness({ seed: 43, behaviours: { US1: { askAdmin: true }, foundational: { questions: [{ text: "Which DB?", choices: ["pg", "dynamo"] }] } }, settings: { notificationChannel: null } });
    expect(await h.runUntil(async () => (await h.repos.getRunNode(runId, "US1"))!.state === "escalated", { maxSteps: 3000 })).toBe(true);
    await h.runUntil(async () => false, { maxIdle: 3, maxSteps: 50 });

    const run = (await get(`/v1/runs/${runId}`)).body as Record<string, unknown> & { nodes: Array<Record<string, unknown>>; notifications: Array<Record<string, unknown>> };
    expect(run).toMatchObject({ runId, state: "running", actingFor: "dev_op", costUsd: expect.any(Number), counts: expect.objectContaining({ merged: 1, escalated: 1 }) });
    const us1 = run.nodes.find((n) => n.nodeId === "US1")!;
    expect(us1).toMatchObject({ title: expect.any(String), state: "escalated", attempt: 1, rovaraTaskUrl: expect.stringContaining("https://rovara.test/tasks/"), pullRequests: [] });
    expect(run.notifications).toEqual([expect.objectContaining({ nodeId: "US1", template: "adminRequest", delivered: false, lastError: expect.stringContaining("no Slack notification channel") })]);

    const node = (await get(`/v1/runs/${runId}/nodes/foundational`)).body as Record<string, unknown> & { attempts: Array<Record<string, unknown>>; decisions: unknown[] };
    expect(node).toMatchObject({ nodeId: "foundational", state: "merged", unblockedBySkip: [], pageUrl: `https://status.test/#/runs/${runId}/nodes/foundational` });
    const a = node.attempts[0]!;
    expect(a).toMatchObject({ n: 1, phase: "merged", rovaraTaskUrl: expect.any(String), checkReports: [expect.objectContaining({ status: "passed" })] });
    expect(a.pullRequests).toEqual([expect.objectContaining({ state: "merged", url: expect.stringContaining("/pull/") })]);
    expect(a.questions).toEqual([expect.objectContaining({ question: "Which DB?", answer: expect.any(String) })]);
    expect(a.reviewComments).toEqual(expect.any(Array));
    expect(node.decisions.map((d) => (d as { action: string }).action)).toEqual(expect.arrayContaining(["approve", "answer", "merge"]));
    expect((await get(`/v1/runs/${runId}/nodes/NOPE`)).status).toBe(404);
  });
});
