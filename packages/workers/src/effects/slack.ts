import type { Executor } from "./types.js";

/**
 * slack.post and slack.reply. A post records its `ts` under `SLACKMSG#<key>` so a later reply
 * (payload.replyTo = the post's intent key) finds its thread. The Slack client is idempotent by key.
 * Until a post succeeds it stays a pending intent, so it shows on the run's status as undelivered.
 */
export const slack: Executor = async (intent, deps) => {
  const payload = intent.payload as { text: string; channel?: string; replyTo?: string };
  const channel = payload.channel ?? (await deps.repos.getSettings()).notificationChannel;
  if (!channel) throw new Error("no Slack notification channel is configured");
  if (intent.effect === "slack.reply") {
    if (!payload.replyTo) throw new Error("slack.reply needs replyTo");
    const root = await deps.table.get<{ ts: string; channel: string }>({ pk: `SLACKMSG#${payload.replyTo}`, sk: "META" });
    if (!root) throw new Error(`the message being replied to (${payload.replyTo}) is not posted yet`);
    const r = await deps.slack.reply({ channel: root.channel, threadTs: root.ts, text: payload.text, key: intent.key });
    return { ts: r.ts, threadTs: root.ts };
  }
  const r = await deps.slack.post({ channel, text: payload.text, key: intent.key });
  await deps.table.transact([
    { kind: "put", item: { pk: `SLACKMSG#${intent.key}`, sk: "META", entityType: "SLACKMSG", ts: r.ts, channel } },
  ]);
  return { ts: r.ts, channel };
};
