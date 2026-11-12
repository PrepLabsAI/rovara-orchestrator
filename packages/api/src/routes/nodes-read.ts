import { attemptIdOf, attemptThread, type Question, type ReviewComment } from "@rovara-orch/core";
import { ApiError } from "../errors.js";
import type { ApiDeps, Route } from "../types.js";
import { pageLink } from "./runs.js";

/**
 * One node: its state, every attempt with its phase, check reports, questions and answers, review
 * comments and pull requests, and the node's decision records (contracts/operator-api.md).
 */
export async function nodeView(deps: Pick<ApiDeps, "table" | "repos" | "config">, runId: string, nodeId: string) {
  const run = await deps.repos.getRun(runId);
  const node = run ? await deps.repos.getRunNode(runId, nodeId) : undefined;
  if (!run || !node) throw new ApiError("NOT_FOUND", `no node ${nodeId} in run ${runId}`);
  const dagNode = (await deps.repos.getDagNodes(run.dagId)).find((n) => n.nodeId === nodeId);
  const attempts = await Promise.all(
    Array.from({ length: node.attempts }, async (_, i) => {
      const attemptId = attemptIdOf(attemptThread(runId, nodeId, i + 1));
      const [a, questions, comments] = await Promise.all([
        deps.repos.getAttempt(attemptId),
        deps.table.query<Question>(`ATT#${attemptId}`, "Q#"),
        deps.table.query<ReviewComment>(`ATT#${attemptId}`, "RC#"),
      ]);
      if (!a) return undefined;
      return {
        attemptId,
        n: a.n,
        phase: a.phase,
        outcome: a.outcome,
        outcomeReason: a.outcomeReason,
        startedAt: a.startedAt,
        endedAt: a.endedAt,
        baseCommit: a.baseCommit,
        rovaraTaskUrl: a.rovaraTaskUrl,
        checkReports: a.checkReports,
        fixRequests: a.fixRequests,
        pullRequests: a.pullRequests,
        costUsd: a.costUsd,
        questions: questions.map((q) => ({ eventId: q.eventId, question: q.question, choices: q.choices, answer: q.answer, choice: q.choice, answeredBy: q.answeredBy, at: q.at })),
        reviewComments: comments.map(({ pk: _p, sk: _s, ...c }: ReviewComment & { pk?: string; sk?: string }) => c),
      };
    }),
  );
  const decisions = (await deps.repos.listDecisions(runId)).filter((d) => d.nodeId === nodeId);
  // Dependencies that were skipped rather than merged: the node page says so.
  const depStates = new Map((await deps.repos.getRunNodes(runId)).map((n) => [n.nodeId, n.state]));
  const unblockedBySkip = (dagNode?.dependsOn ?? []).filter((dep) => depStates.get(dep) === "skipped");
  const { version: _v, ...state } = node;
  return {
    ...state,
    pageUrl: pageLink(deps.config.statusPageUrl, `/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}`),
    unblockedBySkip,
    title: dagNode?.title ?? nodeId,
    kind: dagNode?.kind ?? null,
    dependsOn: dagNode?.dependsOn ?? [],
    files: dagNode?.files ?? [],
    attempts: attempts.filter((a) => a !== undefined),
    decisions: decisions.map(({ pk: _p, sk: _s, entityType: _e, ...d }) => d),
  };
}

export const routes: Route[] = [
  {
    method: "GET",
    pattern: "/v1/runs/:runId/nodes/:nodeId",
    handler: async ({ deps, params }) => ({ status: 200, body: await nodeView(deps, params.runId!, params.nodeId!) }),
  },
];
