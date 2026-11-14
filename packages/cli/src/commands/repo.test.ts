import { describe, expect, test } from "vitest";
import { cliHarness } from "./testing.js";

describe("rovara-orch repo", () => {
  test("status prints the pause state and capacity", async () => {
    const t = cliHarness(() => ({ status: 200, body: { repo: "acme/mono", paused: true, pausedSince: "2026-11-11T00:00:00.000Z", mainCommit: "c".repeat(40), startRate: 250, rovaraFreeWorkspaces: 40 } }));
    expect(await t.run("repo", "status", "acme/mono")).toBe(0);
    expect(t.calls[0]).toMatchObject({ method: "GET", path: "/v1/repos/acme/mono" });
    const out = t.lines.join("\n");
    expect(out).toMatch(/paused since 2026-11-11/);
    expect(out).toContain("250 starts a minute");
    expect(out).toContain("40 free workspaces");
  });

  test("workspace-limit sends both limits", async () => {
    const t = cliHarness(() => ({ status: 202, body: {} }));
    expect(await t.run("repo", "workspace-limit", "acme/mono", "--open", "1000", "--per-person", "1000")).toBe(0);
    expect(t.calls[0]).toMatchObject({ method: "POST", path: "/v1/repos/acme/mono/workspace-limit", body: { openWorkspaces: 1000, openWorkspacesPerPerson: 1000 } });
  });

  test("a non-administrator is refused with exit 1; not available yet is reported", async () => {
    const t = cliHarness(() => ({ status: 403, body: { error: { code: "NOT_OPERATOR", message: "only a Rovara administrator can change the workspace limit", problem: "not_rovara_admin" } } }));
    expect(await t.run("repo", "workspace-limit", "acme/mono", "--open", "10", "--per-person", "10")).toBe(1);
    expect(t.errors.join("\n")).toContain("Rovara administrator");
    const u = cliHarness(() => ({ status: 501, body: { error: { code: "NOT_IMPLEMENTED", message: "not available until PrepLabsAI/Rovara#430" } } }));
    expect(await u.run("repo", "workspace-limit", "acme/mono", "--open", "10", "--per-person", "10")).not.toBe(0);
    expect(u.errors.join("\n")).toContain("Rovara#430");
  });
});
