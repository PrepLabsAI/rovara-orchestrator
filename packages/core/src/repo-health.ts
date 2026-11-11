import { enqueueMany, type QueueMessage } from "./machine/helpers.js";
import { ORCHESTRATOR, type RepoHandler } from "./machine/types.js";

/**
 * Main health: stop the line (FR-044). A failing required check on main's head pauses the
 * repository (no starts, no merges, for every run on it) with one Slack message. Green again,
 * confirmed by a fresh read, resumes it: a reply in that message's thread, and a release input for
 * every active attempt so merges held meanwhile go ahead.
 */
export const repoHealth: RepoHandler = (ctx, input) => {
  const repo = ctx.repo;
  if (input.kind === "main_push") {
    if (repo.mainCommit === input.headSha) return undefined;
    return { repo: { ...repo, mainCommit: input.headSha }, intents: [], decisions: [] };
  }
  if (input.kind !== "main_checks" || input.status === "pending") return undefined;

  if (input.status === "failed") {
    if (repo.paused) return undefined;
    const key = `repo-paused:${repo.repo}:${ctx.now}`;
    return {
      repo: { ...repo, paused: true, pausedSince: ctx.now, failingChecks: input.failing, mainCommit: input.headSha, notification: { slackKey: key } },
      intents: [
        { effect: "slack.post", key, payload: { template: "repoPaused", params: { repo: repo.repo, checks: input.failing, commit: input.headSha, runs: ctx.runs.length } } },
      ],
      decisions: [{ actor: ORCHESTRATOR, action: "pause", reason: `main is failing ${input.failing.join(", ") || "its required checks"} at ${input.headSha}`, detail: { repo: repo.repo } }],
    };
  }

  // passed
  if (!repo.paused) return repo.mainCommit === input.headSha ? undefined : { repo: { ...repo, mainCommit: input.headSha }, intents: [], decisions: [] };
  if (!input.confirmed) return undefined;
  const release: QueueMessage[] = ctx.runs.flatMap(({ activeAttempts }) =>
    activeAttempts.map((attemptId) => ({
      group: `att:${attemptId}` as const,
      input: { kind: "control" as const, action: "release" as const, by: ORCHESTRATOR, reason: "main is green again" },
      inputId: `release:${attemptId}:main-green:${repo.pausedSince}`,
    })),
  );
  return {
    repo: { ...repo, paused: false, pausedSince: null, failingChecks: [], mainCommit: input.headSha, notification: null },
    intents: [
      ...(repo.notification
        ? [{ effect: "slack.reply" as const, key: `reply:${repo.notification.slackKey}`, payload: { replyTo: repo.notification.slackKey, template: "mainGreen", params: { commit: input.headSha } } }]
        : []),
      ...(release.length ? [enqueueMany(release, `main-green:${repo.repo}:${repo.pausedSince}`)] : []),
    ],
    decisions: [{ actor: ORCHESTRATOR, action: "resume", reason: `main is green again at ${input.headSha}`, detail: { repo: repo.repo } }],
  };
};
