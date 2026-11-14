import { messages, replies } from "@rovara-orch/slack";
import type { Deps } from "../ports.js";
import type { Executor } from "./types.js";

type Params = Record<string, unknown> & { runId?: string; nodeId?: string; rovaraTask?: string | null; pullRequest?: string | null };

/** Render a template with links to the status page (contracts/notifications-and-answers.md). */
export function render(deps: Deps, payload: { text?: string; template?: string; params?: Params }): string {
  if (payload.text) return payload.text;
  const p = payload.params ?? {};
  const base = deps.config.statusPageUrl.replace(/\/$/, "");
  const links = {
    run: `${base}/runs/${p.runId ?? ""}`,
    ...(p.nodeId ? { node: `${base}/runs/${p.runId}/nodes/${p.nodeId}` } : {}),
    rovaraTask: p.rovaraTask ?? null,
    pullRequest: p.pullRequest ?? null,
  };
  switch (payload.template) {
    case "nodeEscalated":
      return messages.nodeEscalated({ runId: String(p.runId), nodeId: String(p.nodeId), reason: String(p.reason), links });
    case "adminRequest":
      return messages.adminRequest({ runId: String(p.runId), nodeId: String(p.nodeId), links });
    case "costLimit":
      return messages.costLimit({ runId: String(p.runId), limitUsd: Number(p.limitUsd), links });
    case "lostAccess":
      return messages.lostAccess({ runId: String(p.runId), operator: String(p.operator), links });
    case "repoPaused":
      return messages.repoPaused({ repo: String(p.repo), checks: (p.checks as string[]) ?? [], commit: String(p.commit), runs: Number(p.runs ?? 0) });
    case "nodeResolved":
      return replies.nodeResolved({ action: p.action as "retried", operator: String(p.operator), reason: String(p.reason) });
    case "mainGreen":
      return replies.mainGreen({ commit: String(p.commit) });
    case "runResolved":
      return replies.runResolved({ how: String(p.how), operator: String(p.operator) });
    default:
      throw new Error(`unknown Slack template ${payload.template}`);
  }
}

/**
 * slack.post and slack.reply. A post records its `ts` under `SLACKMSG#<key>` so a later reply
 * (payload.replyTo = the post's intent key) finds its thread. The Slack client is idempotent by key.
 * Until a post succeeds it stays a pending intent, so it shows on the run's status as undelivered.
 */
export const slack: Executor = async (intent, deps) => {
  const payload = intent.payload as { text?: string; template?: string; params?: Params; channel?: string; replyTo?: string };
  const text = render(deps, payload);
  const channel = payload.channel ?? (await deps.repos.getSettings()).notificationChannel;
  if (!channel) throw new Error("no Slack notification channel is configured");
  if (intent.effect === "slack.reply") {
    if (!payload.replyTo) throw new Error("slack.reply needs replyTo");
    const root = await deps.table.get<{ ts: string; channel: string }>({ pk: `SLACKMSG#${payload.replyTo}`, sk: "META" });
    if (!root) throw new Error(`the message being replied to (${payload.replyTo}) is not posted yet`);
    const r = await deps.slack.reply({ channel: root.channel, threadTs: root.ts, text, key: intent.key });
    return { ts: r.ts, threadTs: root.ts };
  }
  const r = await deps.slack.post({ channel, text, key: intent.key });
  await deps.table.transact([
    { kind: "put", item: { pk: `SLACKMSG#${intent.key}`, sk: "META", entityType: "SLACKMSG", ts: r.ts, channel } },
  ]);
  return { ts: r.ts, channel };
};
