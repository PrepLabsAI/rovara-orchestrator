import { describe, expect, test } from "vitest";
import { MemoryTokenStore, runCli } from "@rovara-orch/cli";

/**
 * Quickstart section 3 against the TEST stage: Rovara TEST and the test monorepo (SC-001).
 * Runs only with E2E=1, and needs:
 *   ROVARA_ORCH_URL  the TEST stage's API
 *   E2E_TOKEN        an operator session token for it (from `rovara-orch login`)
 *   E2E_DAG          the 6-node speckit-dag file (Setup -> Foundational -> US1, US2, US3 -> Polish)
 */
const env = process.env;
const enabled = env.E2E === "1";

async function cli(...argv: string[]): Promise<{ code: number; json: unknown; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const tokens = new MemoryTokenStore();
  await tokens.set(env.ROVARA_ORCH_URL!, env.E2E_TOKEN!);
  const code = await runCli(["--json", ...argv], { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, tokens, env });
  return { code, json: out.length ? JSON.parse(out.join("\n")) : null, err: err.join("\n") };
}

interface Status {
  state: string;
  counts: Record<string, number>;
  nodes: Array<{ nodeId: string; state: string; pullRequests: Array<{ state: string }> }>;
}
const status = async (runId: string) => (await cli("run", "status", runId)).json as Status;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await sleep(15_000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe.skipIf(!enabled)("TEST stage: a 6-node run end to end (quickstart section 3)", () => {
  test("imports, runs to complete with the stop check, one merged PR per node", async () => {
    const imported = await cli("dag", "import", env.E2E_DAG!);
    expect(imported.code, imported.err).toBe(0);
    const { dagId } = imported.json as { dagId: string };

    const started = await cli("run", "start", dagId, "--concurrency", "3", "--cost-limit", "50");
    expect(started.code, started.err).toBe(0);
    const { runId } = started.json as { runId: string };

    // Stop check: once the three stories run, nothing starts, approves or merges while the switch is on.
    const stories = ["US1", "US2", "US3"];
    await waitFor("US1 to US3 running", async () => (await status(runId)).nodes.filter((n) => stories.includes(n.nodeId) && n.state !== "waiting" && n.state !== "eligible").length === 3, 90 * 60_000);
    expect((await cli("stop", "on", "--reason", "e2e stop check")).code).toBe(0);
    try {
      const before = await status(runId);
      await sleep(10 * 60_000);
      const after = await status(runId);
      expect(after.counts.merged ?? 0, "nothing merges while the stop switch is on").toBe(before.counts.merged ?? 0);
      expect(after.nodes.find((n) => n.nodeId === "Polish")?.state).toBe("waiting");
    } finally {
      expect((await cli("stop", "off", "--reason", "e2e stop check done")).code).toBe(0);
    }

    await waitFor("the run to complete", async () => (await status(runId)).state === "complete", 4 * 60 * 60_000);
    const done = await status(runId);
    expect(done.nodes.every((n) => n.state === "merged")).toBe(true);
    for (const n of done.nodes) expect(n.pullRequests.filter((p) => p.state === "merged"), `${n.nodeId}: one merged PR`).toHaveLength(1);
  });
});
