import type { AttemptContext, RepoContext, RunContext } from "@rovara-orch/core";
import { FINAL_NODE_STATES } from "@rovara-orch/core";
import type { Deps } from "./ports.js";

export async function loadAttemptContext(deps: Deps, attemptId: string): Promise<AttemptContext | undefined> {
  const attempt = await deps.repos.getAttempt(attemptId);
  if (!attempt) return undefined;
  const [node, run] = await Promise.all([deps.repos.getRunNode(attempt.runId, attempt.nodeId), deps.repos.getRun(attempt.runId)]);
  if (!node || !run) return undefined;
  const [dag, dagNodes, repo, settings] = await Promise.all([
    deps.repos.getDag(run.dagId),
    deps.repos.getDagNodes(run.dagId),
    deps.repos.getRepo(run.repo),
    deps.repos.getSettings(),
  ]);
  const dagNode = dagNodes.find((n) => n.nodeId === attempt.nodeId);
  if (!dag || !dagNode) return undefined;
  return { now: deps.clock.now().toISOString(), attempt, node, run, dag, dagNode, repo, settings };
}

export async function loadRunContext(deps: Deps, runId: string): Promise<RunContext | undefined> {
  const run = await deps.repos.getRun(runId);
  if (!run) return undefined;
  const [dag, dagNodes, nodes, repo, settings, actingForIsAdmin] = await Promise.all([
    deps.repos.getDag(run.dagId),
    deps.repos.getDagNodes(run.dagId),
    deps.repos.getRunNodes(runId),
    deps.repos.getRepo(run.repo),
    deps.repos.getSettings(),
    deps.operators.isRovaraAdmin(run.actingFor).catch(() => false),
  ]);
  if (!dag) return undefined;
  return { now: deps.clock.now().toISOString(), run, dag, dagNodes, nodes, repo, settings, actingForIsAdmin };
}

export async function loadRepoContext(deps: Deps, repoName: string): Promise<RepoContext> {
  const [repo, settings, runs] = await Promise.all([
    deps.repos.getRepo(repoName),
    deps.repos.getSettings(),
    deps.repos.listActiveRuns(repoName),
  ]);
  const withAttempts = await Promise.all(
    runs.map(async (run) => {
      const nodes = await deps.repos.getRunNodes(run.runId);
      const activeAttempts = nodes
        .filter((n) => !FINAL_NODE_STATES.includes(n.state) && n.currentAttempt)
        .map((n) => n.currentAttempt!);
      return { run, activeAttempts };
    }),
  );
  return { now: deps.clock.now().toISOString(), repo, settings, runs: withAttempts };
}
