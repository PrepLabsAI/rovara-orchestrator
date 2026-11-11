import { describe, expect, test } from "vitest";
import { cliHarness } from "./testing.js";

describe("rovara-orch node retry | skip | cancel", () => {
  test.each(["retry", "skip", "cancel"])("%s posts the reason with an idempotency key", async (action) => {
    const t = cliHarness(() => ({ status: 202, body: { decisionId: "dec_1" } }));
    expect(await t.run("node", action, "run_1", "US1", "--reason", "fixed the script")).toBe(0);
    expect(t.calls[0]).toMatchObject({ method: "POST", path: `/v1/runs/run_1/nodes/US1/${action}`, body: { reason: "fixed the script" } });
    expect(t.calls[0]!.idempotencyKey).toBeTruthy();
    expect(t.lines.join("\n")).toContain("dec_1");
  });

  test.each(["retry", "skip", "cancel"])("%s without --reason is a usage error", async (action) => {
    const t = cliHarness(() => ({ status: 202, body: {} }));
    expect(await t.run("node", action, "run_1", "US1")).toBe(2);
    expect(t.calls).toHaveLength(0);
  });

  test("a node that is not escalated exits 1 with the API's message", async () => {
    const t = cliHarness(() => ({ status: 409, body: { error: { code: "CONFLICT", message: "US1 is running, not escalated", problem: "not_escalated" } } }));
    expect(await t.run("node", "retry", "run_1", "US1", "--reason", "x")).toBe(1);
    expect(t.errors.join("\n")).toContain("not escalated");
  });
});
