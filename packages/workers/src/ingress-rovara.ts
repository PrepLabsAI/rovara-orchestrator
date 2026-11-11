import { attemptIdOf, enqueue, parseAttemptThread, type RovaraInput } from "@rovara-orch/core";
import { ChannelEventSchema, SignatureRejected, verify, type ChannelEvent } from "@rovara-orch/rovara";
import { ConditionFailed, intentOps, keys, type Op } from "@rovara-orch/store";
import type { Deps } from "./ports.js";
import { ROVARA_EVENT_HOOKS, type RovaraEventHook } from "./rovara-event-hooks.js";

export interface HttpRequest {
  headers: Record<string, string | undefined>;
  body: string;
}
export interface HttpResponse {
  status: number;
  body?: string;
}

/**
 * POST /rovara/events. Verify, then in ONE transaction write the event's repeat marker, the stored
 * event, the hooks' writes and an enqueue intent for the attempt; answer 2xx only after it commits.
 * A resend after a crash is either dropped as already handled or handled for the first time.
 */
export async function handleRovaraEvent(
  deps: Deps,
  secret: string,
  req: HttpRequest,
  hooks: RovaraEventHook[] = ROVARA_EVENT_HOOKS,
): Promise<HttpResponse> {
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
  try {
    verify(secret, headers, req.body, deps.clock.now());
  } catch (e) {
    if (e instanceof SignatureRejected) return { status: 401, body: e.message };
    throw e;
  }
  let json: unknown;
  try {
    json = JSON.parse(req.body);
  } catch {
    return { status: 400, body: "body is not JSON" };
  }
  if ((json as { type?: unknown }).type === "direct") return { status: 200, body: "ignored" };
  const parsed = ChannelEventSchema.safeParse(json);
  if (!parsed.success) return { status: 400, body: "not a channel event" };
  const event: ChannelEvent = parsed.data;
  if (event.channel !== deps.config.channel || event.conversation.channel !== deps.config.channel) {
    return { status: 403, body: "wrong channel" };
  }

  const now = deps.clock.now().toISOString();
  const thread = parseAttemptThread(event.conversation.thread);
  const attemptId = thread ? attemptIdOf(event.conversation.thread) : null;
  const known = attemptId ? !!(await deps.repos.getAttempt(attemptId)) : false;

  const ops: Op[] = [{ kind: "put", item: { ...keys.eventId(event.id), entityType: "EVID", at: now }, ifNotExists: true }];
  const storeUnder = known ? attemptId! : `unknown:${event.conversation.thread}`;
  ops.push({ kind: "put", item: { ...keys.event(storeUnder, now, event.id), entityType: "EVENT", event, receivedAt: now } });
  if (known) {
    for (const hook of hooks) ops.push(...hook(event, attemptId!, now));
    const input: RovaraInput = { kind: "rovara", eventId: event.id, type: event.type, createdAt: event.createdAt, data: event.data as Record<string, unknown> };
    ops.push(...intentOps(`ATT#${attemptId}`, [enqueue({ group: `att:${attemptId}`, input }, event.id)], now).ops);
  } else {
    deps.log?.({ event: "rovara.unknown_thread", thread: event.conversation.thread, eventId: event.id, type: event.type });
  }
  try {
    await deps.table.transact(ops);
  } catch (e) {
    if (e instanceof ConditionFailed && e.failed.some((op) => op.kind === "put" && op.item.pk === keys.eventId(event.id).pk)) {
      return { status: 200, body: "duplicate" };
    }
    throw e;
  }
  return { status: 200, body: "ok" };
}
