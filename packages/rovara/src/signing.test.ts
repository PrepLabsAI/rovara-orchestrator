import { describe, expect, test } from "vitest";
import { newSecret, sign, SignatureRejected, verify } from "./signing.js";

const secret = newSecret();
const now = new Date("2026-11-11T12:00:00.000Z");

describe("Standard Webhooks signing", () => {
  test("a signed body verifies with the same secret", () => {
    const body = JSON.stringify({ hello: "world" });
    const headers = sign(secret, "evt_0123456789abcdef", now, body);
    expect(Object.keys(headers).sort()).toEqual(["webhook-id", "webhook-signature", "webhook-timestamp"]);
    expect(() => verify(secret, { ...headers }, body, now)).not.toThrow();
  });

  test("a changed body, another secret, missing headers or a stale timestamp are refused", () => {
    const body = "{}";
    const headers = sign(secret, "evt_0123456789abcdef", now, body);
    expect(() => verify(secret, { ...headers }, '{"x":1}', now)).toThrow(SignatureRejected);
    expect(() => verify(newSecret(), { ...headers }, body, now)).toThrow(SignatureRejected);
    expect(() => verify(secret, { "webhook-id": "x" }, body, now)).toThrow(/missing/);
    const sixMinutesLater = new Date(now.getTime() + 6 * 60_000);
    expect(() => verify(secret, { ...headers }, body, sixMinutesLater)).toThrow(/5 minutes/);
    const fourMinutesLater = new Date(now.getTime() + 4 * 60_000);
    expect(() => verify(secret, { ...headers }, body, fourMinutesLater)).not.toThrow();
  });
});
