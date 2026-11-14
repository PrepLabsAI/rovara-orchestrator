import { describe, expect, test } from "vitest";
import { DevIdentity, DevIdentityRefused } from "./dev.js";
import { AuthRequired } from "./operator-identity.js";

const operators = [
  { id: "dev_alice", name: "Alice", admin: true },
  { id: "dev_bob", name: "Bob", admin: false },
];

describe("DevIdentity", () => {
  test("refuses to be constructed in prod", () => {
    expect(() => new DevIdentity({ stage: "prod", operators, signingKey: "k" })).toThrow(DevIdentityRefused);
  });

  test("issues tokens that verify, and reports operator and admin access", async () => {
    const id = new DevIdentity({ stage: "test", operators, signingKey: "k" });
    const { token, operator } = await id.login("dev_bob");
    expect(await id.verify(token)).toEqual(operator);
    expect(await id.access(operator)).toEqual({ isOperator: true, isAdmin: false });
    expect(await id.access({ id: "dev_alice", name: "Alice" })).toEqual({ isOperator: true, isAdmin: true });
    expect(await id.access({ id: "dev_eve", name: "Eve" })).toEqual({ isOperator: false, isAdmin: false });
  });

  test("refuses missing, forged and foreign tokens", async () => {
    const id = new DevIdentity({ stage: "test", operators, signingKey: "k" });
    const other = new DevIdentity({ stage: "test", operators, signingKey: "other-key" });
    const { token } = await other.login("dev_bob");
    await expect(id.verify(undefined)).rejects.toBeInstanceOf(AuthRequired);
    await expect(id.verify("garbage")).rejects.toBeInstanceOf(AuthRequired);
    await expect(id.verify(token)).rejects.toBeInstanceOf(AuthRequired);
    await expect(id.login("dev_eve")).rejects.toBeInstanceOf(AuthRequired);
  });
});
