/** Notification texts (contracts/notifications-and-answers.md). One first message per cause, thread replies on resolution. */

export interface Links {
  run: string;
  node?: string;
  rovaraTask?: string | null;
  pullRequest?: string | null;
}

const linkLine = (l: Links) =>
  [
    `<${l.run}|run>`,
    l.node ? `<${l.node}|node>` : null,
    l.rovaraTask ? `<${l.rovaraTask}|Rovara task>` : null,
    l.pullRequest ? `<${l.pullRequest}|PR>` : null,
  ]
    .filter(Boolean)
    .join(" · ");

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const messages = {
  nodeEscalated: (p: { runId: string; nodeId: string; reason: string; links: Links }) =>
    `:rotating_light: ${p.runId} / ${p.nodeId} escalated: ${p.reason}.\n${linkLine(p.links)}`,
  repoPaused: (p: { repo: string; checks: string[]; commit: string; runs: number }) =>
    `:octagonal_sign: ${p.repo} main is failing ${p.checks.join(", ") || "its required checks"} at ${p.commit.slice(0, 12)}. Dispatch and merges paused for ${p.runs} run${p.runs === 1 ? "" : "s"}.`,
  costLimit: (p: { runId: string; limitUsd: number; links: Links }) =>
    `:moneybag: ${p.runId} reached its cost limit of $${p.limitUsd}. No new nodes start.\n${linkLine(p.links)}`,
  adminRequest: (p: { runId: string; nodeId: string; links: Links }) =>
    `:lock: ${p.runId} / ${p.nodeId}: Rovara asks for an administrator's confirmation.\n${linkLine(p.links)}`,
  lostAccess: (p: { runId: string; operator: string; links: Links }) =>
    `:bust_in_silhouette: ${p.runId} paused: Rovara no longer accepts work for ${p.operator}.\n${linkLine(p.links)}`,
} as const;

export const replies = {
  nodeResolved: (p: { action: "retried" | "skipped" | "cancelled"; operator: string; reason: string }) =>
    `${capitalise(p.action)} by ${p.operator}: ${p.reason}.`,
  mainGreen: (p: { commit: string }) => `main is green again at ${p.commit.slice(0, 12)}; resumed.`,
  runResolved: (p: { how: string; operator: string }) => `${capitalise(p.how)} by ${p.operator}.`,
} as const;
