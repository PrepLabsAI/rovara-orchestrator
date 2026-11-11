import { describe, expect, test } from "vitest";
import { signGithubBody, verifyGithubSignature } from "./webhooks.js";

describe("GitHub webhook signatures", () => {
  test("accepts GitHub's signature for the exact body and refuses anything else", () => {
    const body = JSON.stringify({ action: "opened" });
    const sig = signGithubBody("s3cret", body);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyGithubSignature("s3cret", body, sig)).toBe(true);
    expect(verifyGithubSignature("other", body, sig)).toBe(false);
    expect(verifyGithubSignature("s3cret", body + " ", sig)).toBe(false);
    expect(verifyGithubSignature("s3cret", body, undefined)).toBe(false);
    expect(verifyGithubSignature("s3cret", body, "sha1=abc")).toBe(false);
  });

  test("matches GitHub's documented example", () => {
    // https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
    expect(signGithubBody("It's a Secret to Everybody", "Hello, World!")).toBe(
      "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
    );
  });
});
