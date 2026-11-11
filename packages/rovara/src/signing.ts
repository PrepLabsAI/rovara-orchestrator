import { Webhook, WebhookVerificationError } from "standardwebhooks";

/** Standard Webhooks headers, as Rovara sends and expects them (spec 062, FR-021/FR-022). */
export interface SignedHeaders {
  "webhook-id": string;
  "webhook-timestamp": string;
  "webhook-signature": string;
}

export class SignatureRejected extends Error {
  constructor(reason: string) {
    super(`signature rejected: ${reason}`);
    this.name = "SignatureRejected";
  }
}

/** Sign a body with the adapter secret (`whsec_…`). */
export function sign(secret: string, id: string, timestamp: Date, body: string): SignedHeaders {
  const signature = new Webhook(secret).sign(id, timestamp, body);
  return {
    "webhook-id": id,
    "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "webhook-signature": signature,
  };
}

/**
 * Verify a callback: the signature, and a timestamp within 5 minutes of now. Throws SignatureRejected.
 * `now` is injectable so tests can check the window.
 */
export function verify(secret: string, headers: Record<string, string | undefined>, body: string, now: Date = new Date()): void {
  const id = headers["webhook-id"];
  const ts = headers["webhook-timestamp"];
  const sig = headers["webhook-signature"];
  if (!id || !ts || !sig) throw new SignatureRejected("missing webhook headers");
  const seconds = Number(ts);
  if (!Number.isFinite(seconds) || Math.abs(now.getTime() / 1000 - seconds) > 5 * 60) {
    throw new SignatureRejected("timestamp is more than 5 minutes off");
  }
  try {
    const wh = new Webhook(secret);
    // The library checks the timestamp against the system clock; ours is checked above with `now`.
    const expected = wh.sign(id, new Date(seconds * 1000), body).split(",")[1];
    const offered = sig.split(" ").map((s) => s.split(",")[1]);
    if (!offered.some((o) => o !== undefined && timingSafeEqual(o, expected!))) throw new WebhookVerificationError("No matching signature found");
  } catch (e) {
    if (e instanceof WebhookVerificationError) throw new SignatureRejected(e.message);
    throw e;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** A fresh `whsec_` secret, for tests and local fakes. */
export function newSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `whsec_${Buffer.from(bytes).toString("base64")}`;
}
