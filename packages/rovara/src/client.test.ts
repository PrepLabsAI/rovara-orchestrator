import { describe, expect, test } from "vitest";
import { ActorNotLinked, ChannelClient, RovaraRequestFailed, Throttled, WorkspaceLimit } from "./client.js";
import { newSecret, verify } from "./signing.js";

const secret = newSecret();
const conversation = { channel: "orchestrator", tenant: "test", space: "mono", thread: "run_01X.US1.a1" };
const actor = { channel: "orchestrator", tenant: "test", userId: "dev_1" };
const now = new Date("2026-11-11T12:00:00.000Z");

function client(respond: (req: Request) => Response, seen: Request[] = []) {
  return new ChannelClient({
    baseUrl: "https://rovara.test/",
    channel: "orchestrator",
    secret,
    now: () => now,
    fetch: (async (url: string, init: RequestInit) => {
      const req = new Request(url, init);
      seen.push(req.clone());
      return respond(req);
    }) as typeof fetch,
  });
}

describe("ChannelClient", () => {
  test("sends a signed InboundMessage v2 to the messages route", async () => {
    const seen: Request[] = [];
    await client(() => new Response(null, { status: 202 }), seen).sendMessage({ conversation, actor, text: "hello", eventId: "att_1.brief" });
    const req = seen[0]!;
    expect(req.url).toBe("https://rovara.test/v1/channels/orchestrator/messages");
    const body = await req.text();
    expect(JSON.parse(body)).toMatchObject({ version: 2, channel: "orchestrator", eventId: "att_1.brief", text: "hello" });
    expect(() => verify(secret, Object.fromEntries(req.headers), body, now)).not.toThrow();
  });

  test("sends a decision v1 to the decisions route", async () => {
    const seen: Request[] = [];
    await client(() => new Response(null, { status: 202 }), seen).sendDecision({
      conversation,
      actor,
      eventId: "att_1.approve",
      requestId: "8a6e0804-2bd0-4672-b79d-d97027f9071a",
      expectedRevision: 1,
      artifactDigest: "a".repeat(64),
      decision: "APPROVE",
      reason: "orchestrator approves plans for run run_01X node US1",
    });
    expect(seen[0]!.url).toMatch(/\/decisions$/);
    expect(JSON.parse(await seen[0]!.text())).toMatchObject({ version: 1, decision: "APPROVE" });
  });

  test("maps 429 to Throttled, WORKSPACE_LIMIT to WorkspaceLimit, and other errors to RovaraRequestFailed", async () => {
    const send = (c: ChannelClient) => c.sendMessage({ conversation, actor, text: "x", eventId: "e" });
    await expect(send(client(() => new Response(null, { status: 429, headers: { "retry-after": "7" } })))).rejects.toBeInstanceOf(Throttled);
    await expect(
      send(client(() => Response.json({ error: { code: "WORKSPACE_LIMIT", message: "limit" } }, { status: 409 }))),
    ).rejects.toBeInstanceOf(WorkspaceLimit);
    await expect(send(client(() => Response.json({ error: { code: "INVALID", message: "no" } }, { status: 422 })))).rejects.toBeInstanceOf(RovaraRequestFailed);
  });

  test("an operator who has not linked their sign-in: 202 link_required is ActorNotLinked, not success", async () => {
    const seen: Request[] = [];
    const linkRequired = () => new Response(JSON.stringify({ status: "link_required" }), { status: 202, headers: { "content-type": "application/json" } });
    await expect(client(linkRequired, seen).sendMessage({ conversation, actor, text: "hello", eventId: "att_1.brief" })).rejects.toBeInstanceOf(ActorNotLinked);
    const accepted = () => new Response(JSON.stringify({ status: "queued" }), { status: 202, headers: { "content-type": "application/json" } });
    await expect(client(accepted, seen).sendMessage({ conversation, actor, text: "hello", eventId: "att_1.brief2" })).resolves.toBeUndefined();
  });

  test("refuses to send a request that does not match Rovara's schema", async () => {
    await expect(
      client(() => new Response(null, { status: 202 })).sendMessage({ conversation: { ...conversation, thread: "has spaces" }, actor, text: "x", eventId: "e" }),
    ).rejects.toThrow();
  });
});
