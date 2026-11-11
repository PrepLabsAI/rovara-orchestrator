import { afterEach, describe, expect, test } from "vitest";
import type { Intent } from "@rovara-orch/core";
import { encodeAttempt, encodeDag, encodeDagNode, encodeRun, intentOps } from "@rovara-orch/store";
import { aDag, aDagNode, anAttempt, aRun } from "@rovara-orch/core/testing";
import { createHarness, type Harness } from "@rovara-orch/testkit";
import { EXECUTORS } from "./registry.js";

let h: Harness | undefined;
afterEach(async () => h?.drop());

async function setup() {
  h = await createHarness({ name: "effects" });
  const run = aRun({ actingFor: "dev_alice", repo: h.github.repo });
  const attempt = anAttempt({ runId: run.runId });
  await h.table.transact([
    { kind: "put", item: encodeRun(run) },
    { kind: "put", item: encodeAttempt(attempt) },
    { kind: "put", item: encodeDag(aDag({ dagId: run.dagId, repo: h.github.repo, docs: { spec: "specs/x/spec.md" } })) },
    { kind: "put", item: encodeDagNode(aDagNode({ dagId: run.dagId })) },
  ]);
  return { h, run, attempt };
}

/** Run an effect's executor twice, as a redelivered intent would be. */
async function twice(hh: Harness, effect: Intent["effect"], key: string, payload: Record<string, unknown>) {
  const { intents, ops } = intentOps(`ATT#${String(payload.attemptId ?? "x")}`, [{ effect, key, payload }], "2026-11-11T00:00:00.000Z");
  await hh.table.transact(ops);
  const intent = intents[0]!;
  await EXECUTORS[effect](intent, hh.deps);
  await EXECUTORS[effect](intent, hh.deps);
}

describe("effect executors", () => {
  test("Rovara messages and decisions reach Rovara once per key, for the run's acting-for operator", async () => {
    const { h, attempt } = await setup();
    const actors: string[] = [];
    const send = h.rovara.sendMessage.bind(h.rovara);
    h.rovara.sendMessage = async (i) => (actors.push(i.actor.userId), send(i));
    await twice(h, "rovara.message", `${attempt.attemptId}.brief`, { attemptId: attempt.attemptId, text: "Implement it." });
    await twice(h, "rovara.close", `${attempt.attemptId}.close`, { attemptId: attempt.attemptId });
    const decide = h.rovara.sendDecision.bind(h.rovara);
    h.rovara.sendDecision = async (i) => (actors.push(i.actor.userId), decide(i));
    await twice(h, "rovara.decision", `${attempt.attemptId}.approve.r1`, {
      attemptId: attempt.attemptId,
      requestId: "8a6e0804-2bd0-4672-b79d-d97027f9071a",
      expectedRevision: 1,
      artifactDigest: "a".repeat(64),
      decision: "APPROVE",
      reason: "orchestrator approves",
    });
    const conv = h.rovara.conversations.get(attempt.conversation.thread)!;
    expect(conv.received.map((r) => r.kind)).toEqual(["message", "message", "decision"]);
    expect(h.rovara.duplicateRequests).toHaveLength(3);
    expect(new Set(actors)).toEqual(new Set(["dev_alice"]));
  });

  test("GitHub enqueue, resolve, comment and close reach GitHub with one effect each", async () => {
    const { h, attempt } = await setup();
    const { number } = h.github.openPull({ headRef: "x", title: "t", files: ["a.ts"] });
    const head = (await h.github.getPull(h.github.repo, number)).headSha;
    await twice(h, "github.enqueue", `enqueue:${number}:${head}`, { attemptId: attempt.attemptId, repo: h.github.repo, number, headSha: head });
    expect(h.github.merges).toHaveLength(1);
    const other = h.github.openPull({ headRef: "y", title: "t2", files: ["b.ts"] });
    await twice(h, "github.close_pr", `closepr:${other.number}`, { attemptId: attempt.attemptId, repo: h.github.repo, number: other.number });
    expect((await h.github.getPull(h.github.repo, other.number)).state).toBe("closed");
  });

  test("a merge-queue intent whose attempt was cancelled before it ran is not sent (nothing merges after a cancel)", async () => {
    const { h, attempt } = await setup();
    await h.table.transact([{ kind: "put", item: encodeAttempt({ ...attempt, phase: "cancelled", outcome: "cancelled" }) }]);
    const { number } = h.github.openPull({ headRef: "x", title: "t", files: ["a.ts"] });
    const head = (await h.github.getPull(h.github.repo, number)).headSha;
    await twice(h, "github.enqueue", `enqueue:${number}:${head}`, { attemptId: attempt.attemptId, repo: h.github.repo, number, headSha: head });
    expect(h.github.enqueueCalls).toHaveLength(0);
    expect(h.github.merges).toHaveLength(0);
  });

  test("the model executor asks the model once, then sends the answer and the cost to the attempt", async () => {
    const { h, attempt } = await setup();
    await twice(h, "model.answer", `${attempt.attemptId}.answer.evt_q1`, { attemptId: attempt.attemptId, eventId: "evt_q1", question: "24h or 7d?", choices: ["24h", "7d"] });
    expect(h.model.requests).toHaveLength(1);
    expect(h.model.requests[0]!.tasks.length).toBeGreaterThan(0);
    const pending = await h.table.query<{ effect: string; key: string }>(`ATT#${attempt.attemptId}`, "INTENT#");
    expect(pending.map((p) => p.effect).sort()).toEqual(expect.arrayContaining(["queue.enqueue", "rovara.message"]));
    expect(pending.filter((p) => p.key === `${attempt.attemptId}.answer-msg.evt_q1`)).toHaveLength(1);
    expect(await h.table.get({ pk: `ATT#${attempt.attemptId}`, sk: "Q#evt_q1" })).toMatchObject({ answer: "Use 24h.", answeredBy: "anthropic.claude-opus-5-5" });
  });
});
