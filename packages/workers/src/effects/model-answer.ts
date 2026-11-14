import { loadSpecDocs } from "@rovara-orch/answerer";
import { enqueue, type Question } from "@rovara-orch/core";
import { ConditionFailed, intentOps, keys } from "@rovara-orch/store";
import { attemptIdOf } from "./actor.js";
import type { Executor } from "./types.js";

/**
 * model.answer: ask the answering model, then in one transaction write the Question record, a
 * Rovara message carrying the answer, and an `answered` input for the attempt (its cost). A rerun
 * finds the Question record and does not ask again (FR-027).
 */
export const modelAnswer: Executor = async (intent, deps) => {
  const p = intent.payload as { eventId: string; question: string; choices: string[] };
  const attemptId = attemptIdOf(intent.payload);
  const qKey = keys.question(attemptId, p.eventId);
  const existing = await deps.table.get<Question>(qKey);
  if (existing) return { answeredBy: existing.answeredBy, reused: true };

  const attempt = await deps.repos.getAttempt(attemptId);
  if (!attempt) throw new Error(`no attempt ${attemptId}`);
  const run = await deps.repos.getRun(attempt.runId);
  const dag = run ? await deps.repos.getDag(run.dagId) : undefined;
  const dagNode = dag ? (await deps.repos.getDagNodes(dag.dagId)).find((n) => n.nodeId === attempt.nodeId) : undefined;
  if (!dag || !dagNode) throw new Error(`no DAG for attempt ${attemptId}`);
  const settings = await deps.repos.getSettings();
  const specDocs = await loadSpecDocs(deps.github, dag);
  const r = await deps.answerer.answer({
    question: p.question,
    choices: p.choices ?? [],
    specDocs,
    tasks: dagNode.tasks.map((t) => ({ id: t.id, text: t.text })),
    modelId: settings.modelId,
  });
  const now = deps.clock.now().toISOString();
  const question: Question = { attemptId, eventId: p.eventId, question: p.question, choices: p.choices ?? [], answer: r.answer, choice: r.choice, answeredBy: r.answeredBy, tries: r.tries, costUsd: r.costUsd, at: now };
  const text = r.choice ? `${r.answer}\n\n(Choice: ${r.choice})` : r.answer;
  const { ops } = intentOps(`ATT#${attemptId}`, [
    { effect: "rovara.message", key: `${attemptId}.answer-msg.${p.eventId}`, payload: { attemptId, text } },
    enqueue({ group: `att:${attemptId}`, input: { kind: "answered", eventId: p.eventId, costUsd: r.costUsd } }, `answered:${attemptId}:${p.eventId}`),
  ], now);
  try {
    await deps.table.transact([{ kind: "put", item: { ...qKey, entityType: "QUESTION", ...question, confidence: r.confidence, citations: r.citations }, ifNotExists: true }, ...ops]);
  } catch (e) {
    if (!(e instanceof ConditionFailed)) throw e; // another run of this intent recorded it first
  }
  return { answeredBy: r.answeredBy, tries: r.tries, costUsd: r.costUsd };
};
