import { describe, expect, test } from "vitest";
import { cliHarness } from "./testing.js";

describe("rovara-orch run take-over", () => {
  test("posts the reason with an idempotency key and prints the decision", async () => {
    const t = cliHarness(() => ({ status: 202, body: { decisionId: "dec_1" } }));
    expect(await t.run("run", "take-over", "run_1", "--reason", "Alice is away")).toBe(0);
    expect(t.calls[0]).toMatchObject({ method: "POST", path: "/v1/runs/run_1/take-over", body: { reason: "Alice is away" } });
    expect(t.calls[0]!.idempotencyKey).toBeTruthy();
    expect(t.lines.join("\n")).toContain("dec_1");
  });

  test("needs --reason", async () => {
    const t = cliHarness(() => ({ status: 202, body: {} }));
    expect(await t.run("run", "take-over", "run_1")).toBe(2);
  });
});
