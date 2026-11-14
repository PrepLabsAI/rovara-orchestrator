import { afterEach, describe, expect, test } from "vitest";
import { createHarness, SOME_FAULTS, type Harness, type HarnessOptions } from "@rovara-orch/testkit";

let open: Harness[] = [];
afterEach(async () => {
  await Promise.all(open.map((h) => h.drop()));
  open = [];
});

async function start(name: string, nodes: Parameters<Harness["seedDag"]>[0], opts: HarnessOptions) {
  const h = await createHarness({ name, ...opts });
  open.push(h);
  const runId = await h.startRun(await h.seedDag(nodes), { concurrency: 4 });
  const node = async (id: string) => (await h.repos.getRunNode(runId, id))!;
  const mainIndex = (sha: string | null) => h.github.main.findIndex((c) => c.sha === sha);
  return { h, runId, node, mainIndex };
}

describe("a busy monorepo (SC-005)", () => {
  test.each([
    ["clean", { seed: 21 }],
    ["with faults and crashes", { seed: 22, faults: SOME_FAULTS, crash: { ingress: 0.1, consume: 0.1, intent: 0.1 } }],
  ] as const)("nodes listing the same file run one after the other; a conflict is updated and merged (%s)", async (_name, opts: HarnessOptions) => {
    const { h, runId, node, mainIndex } = await start(
      "monorepo",
      [
        // A and B list the same file: never at the same time.
        { nodeId: "A", files: ["src/shared.ts", "src/a.ts"] },
        { nodeId: "B", files: ["src/shared.ts", "src/b.ts"] },
        // C and D list different files but both PRs touch src/routes.ts: the second to merge conflicts.
        { nodeId: "C", files: ["src/c.ts"] },
        { nodeId: "D", files: ["src/d.ts"] },
      ],
      { ...opts, behaviours: { A: { files: ["src/shared.ts"] }, B: { files: ["src/shared.ts"] }, C: { files: ["src/routes.ts"] }, D: { files: ["src/routes.ts"] } } },
    );
    expect(await h.runToEnd(runId, { maxSteps: 5000, maxIdle: 60 })).toBe(true);
    expect((await h.repos.getRun(runId))?.state).toBe("complete");

    // The second of A and B started from main at or after the first one's merge.
    const [a, b] = [await node("A"), await node("B")];
    const [first, second] = mainIndex(a.mergeCommit) < mainIndex(b.mergeCommit) ? [a, b] : [b, a];
    const secondAttempt = (await h.repos.getAttempt(second.currentAttempt!))!;
    expect(mainIndex(secondAttempt.baseCommit)).toBeGreaterThanOrEqual(mainIndex(first.mergeCommit));

    // C and D ran together; one conflicted, was asked to update from main, and merged.
    const updated = [await node("C"), await node("D")].filter((n) => n.prUpdates > 0);
    expect(updated).toHaveLength(1);
    const asked = h.rovara.attemptsFor(updated[0]!.nodeId).flatMap((c) => c.received).filter((r) => /update the pull request from main/i.test(r.text));
    expect(asked.length).toBeGreaterThanOrEqual(1);
    expect(h.github.merges).toHaveLength(4);
    // No file lock is left behind.
    expect(await h.table.query("REPO#acme/mono", "FILE#")).toEqual([]);
  });

  test("with main red nothing starts or merges until it is green", async () => {
    const { h, runId, node } = await start(
      "main-red",
      [
        { nodeId: "foundational", kind: "foundational", files: ["src/db.ts"] },
        { nodeId: "US1", dependsOn: ["foundational"], files: ["src/signup.ts"] },
        { nodeId: "US2", dependsOn: ["foundational"], files: ["src/login.ts"] },
        { nodeId: "US3", dependsOn: ["US1"], files: ["src/billing.ts"] },
      ],
      { seed: 23 },
    );
    expect(await h.runUntil(async () => (await node("foundational")).state === "merged" && h.rovara.attemptsFor("US1").length === 1)).toBe(true);

    h.github.breakMain();
    expect(await h.runUntil(async () => (await h.repos.getRepo("acme/mono")).paused)).toBe(true);
    const merges = h.github.merges.length;
    const conversations = ["US1", "US2", "US3"].map((id) => h.rovara.attemptsFor(id).length);
    for (let minute = 0; minute < 30; minute++) {
      await h.idle();
      for (let s = 0; s < 20 && (await h.step()); s++);
    }
    expect(h.github.merges.length, "nothing merges while main is red").toBe(merges);
    expect(["US1", "US2", "US3"].map((id) => h.rovara.attemptsFor(id).length), "nothing starts while main is red").toEqual(conversations);
    expect(h.slack.posts.filter((p) => p.text.includes("main is failing"))).toHaveLength(1);
    // US3 waits for US1, or, if US1 merged just before the pause, is held because main is red.
    const us3 = await node("US3");
    if (us3.state !== "waiting") expect(us3).toMatchObject({ state: "eligible", waitingFor: { reason: "main_red" } });

    h.github.fixMain();
    expect(await h.runToEnd(runId, { maxSteps: 5000, maxIdle: 60 })).toBe(true);
    expect((await h.repos.getRun(runId))?.state).toBe("complete");
    expect((await h.repos.getRepo("acme/mono")).paused).toBe(false);
    expect(h.slack.replies.filter((r) => r.text.includes("main is green again"))).toHaveLength(1);
  });
});
