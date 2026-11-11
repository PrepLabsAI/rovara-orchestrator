import { ChannelDecisionSchema, InboundMessageSchema, type ActorRef, type ConversationRef } from "./contract/channel.js";
import { sign } from "./signing.js";

export class Throttled extends Error {
  constructor(readonly retryAfterSeconds: number | null) {
    super("Rovara is throttling requests");
    this.name = "Throttled";
  }
}

export class WorkspaceLimit extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceLimit";
  }
}

export class RovaraRequestFailed extends Error {
  constructor(readonly status: number, readonly code: string | null, message: string) {
    super(`Rovara answered ${status}${code ? ` ${code}` : ""}: ${message}`);
    this.name = "RovaraRequestFailed";
  }
}

export interface ChannelClientOptions {
  baseUrl: string;
  channel: string;
  secret: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

/** Signed requests to Rovara's channel API (spec 062): messages and decisions. */
export class ChannelClient {
  private readonly fetch: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly opts: ChannelClientOptions) {
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? (() => new Date());
  }

  async sendMessage(input: { conversation: ConversationRef; actor: ActorRef; text: string; eventId: string }): Promise<void> {
    const body = InboundMessageSchema.parse({
      version: 2,
      channel: this.opts.channel,
      eventId: input.eventId,
      conversation: input.conversation,
      actor: input.actor,
      text: input.text,
      receivedAt: this.now().toISOString(),
    });
    await this.post("messages", input.eventId, body);
  }

  async sendDecision(input: {
    conversation: ConversationRef;
    actor: ActorRef;
    eventId: string;
    requestId: string;
    expectedRevision: number;
    artifactDigest: string;
    decision: "APPROVE" | "REQUEST_CHANGES" | "REJECT" | "SKIP";
    reason: string;
  }): Promise<void> {
    const body = ChannelDecisionSchema.parse({ version: 1, channel: this.opts.channel, ...input, receivedAt: this.now().toISOString() });
    await this.post("decisions", input.eventId, body);
  }

  private async post(kind: "messages" | "decisions", id: string, payload: unknown): Promise<void> {
    const body = JSON.stringify(payload);
    const url = `${this.opts.baseUrl.replace(/\/$/, "")}/v1/channels/${this.opts.channel}/${kind}`;
    const res = await this.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...sign(this.opts.secret, id, this.now(), body) },
      body,
    });
    if (res.ok) return;
    let code: string | null = null;
    let message = res.statusText;
    try {
      const j = (await res.json()) as { error?: { code?: string; message?: string } };
      code = j.error?.code ?? null;
      message = j.error?.message ?? message;
    } catch {
      // not JSON
    }
    if (res.status === 429) {
      const ra = res.headers.get("retry-after");
      throw new Throttled(ra ? Number(ra) : null);
    }
    if (code === "WORKSPACE_LIMIT") throw new WorkspaceLimit(message);
    throw new RovaraRequestFailed(res.status, code, message);
  }
}
