import type { SlackApi } from "@rovara-orch/workers";

/** In-memory Slack: records posts and thread replies, idempotent by key like the real notifier. */
export class FakeSlack implements SlackApi {
  readonly posts: Array<{ channel: string; text: string; key: string; ts: string }> = [];
  readonly replies: Array<{ channel: string; threadTs: string; text: string; key: string; ts: string }> = [];
  /** When set, posting fails (Slack unreachable). */
  down = false;
  private n = 0;

  async post(input: { channel: string; text: string; key: string }): Promise<{ ts: string }> {
    if (this.down) throw new Error("Slack is unreachable");
    const existing = this.posts.find((p) => p.key === input.key);
    if (existing) return { ts: existing.ts };
    const ts = `1700000000.${String(++this.n).padStart(6, "0")}`;
    this.posts.push({ ...input, ts });
    return { ts };
  }

  async reply(input: { channel: string; threadTs: string; text: string; key: string }): Promise<{ ts: string }> {
    if (this.down) throw new Error("Slack is unreachable");
    const existing = this.replies.find((p) => p.key === input.key);
    if (existing) return { ts: existing.ts };
    const ts = `1700000000.${String(++this.n).padStart(6, "0")}`;
    this.replies.push({ ...input, ts });
    return { ts };
  }
}
