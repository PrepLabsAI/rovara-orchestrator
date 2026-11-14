import { describe, expect, test } from "vitest";
import { cliHarness } from "./testing.js";

describe("rovara-orch run pause | resume | cancel", () => {
  test.each(["pause", "resume", "cancel"])("%s posts the reason with an idempotency key and prints the decision", async (action) => {
    const t = cliHarness(() => ({ status: 202, body: { decisionId: "dec_1" } }));
    expect(await t.run("run", action, "run_1", "--reason", "testing")).toBe(0);
    expect(t.calls[0]).toMatchObject({ method: "POST", path: `/v1/runs/run_1/${action}`, body: { reason: "testing" } });
    expect(t.calls[0]!.idempotencyKey).toBeTruthy();
    expect(t.lines.join("\n")).toContain("dec_1");
  });

  test.each(["pause", "resume", "cancel"])("%s without --reason is a usage error", async (action) => {
    const t = cliHarness(() => ({ status: 202, body: {} }));
    expect(await t.run("run", action, "run_1")).toBe(2);
    expect(t.calls).toHaveLength(0);
  });
});
