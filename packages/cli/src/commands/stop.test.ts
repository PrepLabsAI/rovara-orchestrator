import { describe, expect, test } from "vitest";
import { cliHarness } from "./testing.js";

describe("rovara-orch stop", () => {
  test("on and off send the switch with a reason", async () => {
    const t = cliHarness((_m, _p, body) => ({ status: 200, body: { on: (body as { on: boolean }).on, by: "dev_alice", at: "t", reason: "r" } }));
    expect(await t.run("stop", "on", "--reason", "incident")).toBe(0);
    expect(t.calls[0]).toMatchObject({ method: "PUT", path: "/v1/stop-switch", body: { on: true, reason: "incident" } });
    expect(await t.run("stop", "off", "--reason", "fixed")).toBe(0);
    expect(t.calls[1]!.body).toEqual({ on: false, reason: "fixed" });
    expect(t.lines.join("\n")).toMatch(/stop switch is off/i);
  });

  test("status shows whether it is on, and who set it", async () => {
    const t = cliHarness(() => ({ status: 200, body: { on: true, by: "dev_alice", at: "2026-11-11T00:00:00.000Z", reason: "incident" } }));
    expect(await t.run("stop", "status")).toBe(0);
    expect(t.lines.join("\n")).toMatch(/on.*dev_alice.*incident/i);
  });

  test("on without --reason is a usage error", async () => {
    const t = cliHarness(() => ({ status: 200, body: {} }));
    expect(await t.run("stop", "on")).toBe(2);
  });
});
