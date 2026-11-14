import { createHmac, timingSafeEqual } from "node:crypto";

/** Verify GitHub's `X-Hub-Signature-256` header (`sha256=<hex>`) for a raw body. */
export function verifyGithubSignature(secret: string, body: string, header: string | undefined): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Sign a body as GitHub does (for tests and fakes). */
export function signGithubBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}
