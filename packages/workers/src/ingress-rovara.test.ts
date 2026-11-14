import { afterEach, describe, expect, test } from "vitest";
import { newSecret, sign } from "@rovara-orch/rovara";
import { encodeAttempt } from "@rovara-orch/store";
import { anAttempt } from "@rovara-orch/store/testing";
import { handleRovaraEvent } from "./ingress-rovara.js";
import { testDeps } from "./testing/deps.js";

const secret = newSecret();
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => cleanup?.());

const attempt = anAttempt();
function event(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    id: "evt_0123456789abcdefAAAA",
    channel: "orchestrator",
    conversation: attempt.conversation,
    createdAt: "2026-11-11T00:00:00.000Z",
    type: "progress",
    data: { text: "working" },
    ...over,
  };
}
const signed = (body: string, at = new Date("2026-11-11T00:00:00.000Z")) => ({ headers: { ...sign(secret, "evt_x", at, body) }, body });

async function setup() {
  const t = await testDeps("ingress-rovara");
  cleanup = t.cleanup;
  await t.deps.table.transact([{ kind: "put", item: encodeAttempt(attempt) }]);
  return t;
}
const pendingKeys = async (t: Awaited<ReturnType<typeof setup>>) =>
  (await t.deps.table.queryIndex<{ key: string }>("PENDING_INTENT")).map((i) => i.key);

describe("handleRovaraEvent", () => {
  test("stores a verified event and writes one enqueue intent for its attempt", async () => {
    const t = await setup();
    const r = await handleRovaraEvent(t.deps, secret, signed(JSON.stringify(event())));
    expect(r.status).toBe(200);
    expect(await pendingKeys(t)).toEqual(["evt_0123456789abcdefAAAA"]);
    expect((await t.deps.table.query(`ATT#${attempt.attemptId}`, "EV#")).length).toBe(1);
    expect(t.queued).toHaveLength(0);
  });

  test("a resend after a crash before the answer is processed exactly once", async () => {
    const t = await setup();
    const body = JSON.stringify(event());
    expect((await handleRovaraEvent(t.deps, secret, signed(body))).status).toBe(200);
    // the process stopped after the commit, so Rovara never saw the 2xx and resends
    const again = await handleRovaraEvent(t.deps, secret, signed(body));
    expect(again).toEqual({ status: 200, body: "duplicate" });
    expect(await pendingKeys(t)).toHaveLength(1);
  });

  test("refuses a bad signature, a stale timestamp, a wrong channel and a malformed event", async () => {
    const t = await setup();
    const body = JSON.stringify(event());
    expect((await handleRovaraEvent(t.deps, newSecret(), signed(body))).status).toBe(401);
    expect((await handleRovaraEvent(t.deps, secret, signed(body, new Date("2026-11-10T23:50:00.000Z")))).status).toBe(401);
    const wrong = JSON.stringify(event({ channel: "whatsapp", conversation: { ...attempt.conversation, channel: "whatsapp" } }));
    expect((await handleRovaraEvent(t.deps, secret, signed(wrong))).status).toBe(403);
    expect((await handleRovaraEvent(t.deps, secret, signed(JSON.stringify({ hello: 1 })))).status).toBe(400);
    expect(await pendingKeys(t)).toHaveLength(0);
  });

  test("an event for an unknown thread is stored without an enqueue intent", async () => {
    const t = await setup();
    const body = JSON.stringify(event({ id: "evt_0123456789abcdefBBBB", conversation: { ...attempt.conversation, thread: "1700000000.123" } }));
    expect((await handleRovaraEvent(t.deps, secret, signed(body))).status).toBe(200);
    expect(await pendingKeys(t)).toHaveLength(0);
    expect((await t.deps.table.query("ATT#unknown:1700000000.123", "EV#")).length).toBe(1);
  });

  test("hooks add their writes to the same transaction", async () => {
    const t = await setup();
    const hook = async () => [{ kind: "put" as const, item: { pk: `TRACE#${attempt.attemptId}`, sk: "000000000001", text: "working" } }];
    await handleRovaraEvent(t.deps, secret, signed(JSON.stringify(event())), [hook]);
    expect(await t.deps.table.get({ pk: `TRACE#${attempt.attemptId}`, sk: "000000000001" })).toBeDefined();
  });
});
