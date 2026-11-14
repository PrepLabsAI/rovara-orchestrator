import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { MemoryTokenStore, type Api } from "../client.js";
import { runCli } from "../main.js";

function setup(respond: (method: string, path: string, body?: unknown) => { status: number; body: unknown }) {
  const lines: string[] = [];
  const errors: string[] = [];
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const api: Api = { request: async (method, path, body) => (calls.push({ method, path, body }), respond(method, path, body)) };
  const run = (...argv: string[]) =>
    runCli(["--url", "https://orch.test", ...argv], { io: { out: (l) => lines.push(l), err: (l) => errors.push(l) }, tokens: new MemoryTokenStore(), api: () => api });
  return { run, lines, errors, calls };
}

const file = (content: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), "dag-"));
  const p = join(dir, "units.json");
  writeFileSync(p, JSON.stringify(content));
  return p;
};

describe("rovara-orch dag", () => {
  test("import posts the file and prints the dag-id and whether it was new", async () => {
    const t = setup(() => ({ status: 201, body: { dagId: "dag_1", hash: "sha256:ab", created: true } }));
    expect(await t.run("dag", "import", file({ version: 1 }))).toBe(0);
    expect(t.calls[0]).toEqual({ method: "POST", path: "/v1/dags", body: { version: 1 } });
    expect(t.lines).toEqual(["Imported dag_1 (new)."]);
  });

  test("import of a known graph says so", async () => {
    const t = setup(() => ({ status: 200, body: { dagId: "dag_1", hash: "sha256:ab", created: false } }));
    expect(await t.run("dag", "import", file({}))).toBe(0);
    expect(t.lines).toEqual(["Imported dag_1 (already stored; same hash)."]);
  });

  test("a refused import exits 1 with its problem", async () => {
    const t = setup(() => ({ status: 422, body: { error: { code: "INVALID", message: "the spec folder has uncommitted changes", problem: "spec_dirty" } } }));
    expect(await t.run("dag", "import", file({}))).toBe(1);
    expect(t.errors.join("\n")).toContain("spec_dirty");
  });

  test("list and show print the stored fields, or JSON with --json", async () => {
    const dag = { dagId: "dag_1", feature: "Auth", repo: "acme/mono", commit: "c".repeat(40), nodeCount: 6, hash: "sha256:ab", importedAt: "2026-11-11T00:00:00.000Z", importedBy: "dev_alice" };
    const t = setup((_m, path) =>
      path === "/v1/dags" ? { status: 200, body: { items: [dag] } } : { status: 200, body: { ...dag, nodes: [{ nodeId: "setup", title: "Setup", dependsOn: [] }], edges: [] } },
    );
    expect(await t.run("dag", "list")).toBe(0);
    expect(t.lines[0]).toContain("dag_1");
    expect(t.lines[0]).toContain("Auth");
    expect(await t.run("dag", "show", "dag_1")).toBe(0);
    expect(t.lines.join("\n")).toContain("setup");
    expect(await t.run("--json", "dag", "show", "dag_1")).toBe(0);
    expect(JSON.parse(t.lines.at(-1)!)).toMatchObject({ dagId: "dag_1" });
  });

  test("a missing file is a usage error", async () => {
    const t = setup(() => ({ status: 200, body: {} }));
    expect(await t.run("dag", "import", "/no/such/file.json")).toBe(2);
  });
});
