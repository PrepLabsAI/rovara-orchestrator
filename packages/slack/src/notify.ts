/**
 * Idempotent Slack posting. Each post carries its intent key as message metadata; before posting,
 * recent channel history is searched for that key, so a retried intent never posts twice.
 */
type SlackMessage = { ts?: string; metadata?: { event_type?: string; event_payload?: Record<string, unknown> } };

export interface SlackWebLike {
  chat: {
    postMessage(args: Record<string, unknown>): Promise<{ ok?: boolean; ts?: string }>;
  };
  conversations: {
    history(args: Record<string, unknown>): Promise<{ messages?: SlackMessage[] }>;
    replies(args: Record<string, unknown>): Promise<{ messages?: SlackMessage[] }>;
  };
}

export const METADATA_EVENT = "rovara_orch_notification";

export class SlackNotifier {
  constructor(private readonly web: SlackWebLike) {}

  private metadata(key: string) {
    return { event_type: METADATA_EVENT, event_payload: { key } };
  }

  async post(input: { channel: string; text: string; key: string }): Promise<{ ts: string }> {
    const existing = await this.find(input.channel, input.key);
    if (existing) return { ts: existing };
    const r = await this.web.chat.postMessage({
      channel: input.channel,
      text: input.text,
      metadata: this.metadata(input.key),
      unfurl_links: false,
    });
    if (!r.ts) throw new Error("Slack did not return a message ts");
    return { ts: r.ts };
  }

  async reply(input: { channel: string; threadTs: string; text: string; key: string }): Promise<{ ts: string }> {
    const thread = await this.web.conversations.replies({
      channel: input.channel,
      ts: input.threadTs,
      include_all_metadata: true,
      limit: 200,
    });
    const found = thread.messages?.find((m) => m.metadata?.event_payload?.key === input.key)?.ts;
    if (found) return { ts: found };
    const r = await this.web.chat.postMessage({
      channel: input.channel,
      thread_ts: input.threadTs,
      text: input.text,
      metadata: this.metadata(input.key),
      unfurl_links: false,
    });
    if (!r.ts) throw new Error("Slack did not return a message ts");
    return { ts: r.ts };
  }

  private async find(channel: string, key: string): Promise<string | undefined> {
    const r = await this.web.conversations.history({ channel, include_all_metadata: true, limit: 100 });
    return r.messages?.find((m) => m.metadata?.event_type === METADATA_EVENT && m.metadata.event_payload?.key === key)?.ts;
  }
}
