import { describe, expect, test } from "vitest";
import { emptyRepository, type QueueMessage, type Repository } from "./index.js";
import { aRun, aSettings } from "./testing/fixtures.js";
import { repositoryMachine } from "./machine/repository.js";
import type { RepoContext, RepoInput, RepoTransition } from "./machine/types.js";

const main1 = "1".repeat(40);
const main2 = "2".repeat(40);
function ctx(repo: Partial<Repository> = {}): RepoContext {
  return {
    now: "2026-11-11T01:00:00.000Z",
    repo: { ...emptyRepository("acme/mono"), mainCommit: main1, ...repo },
    runs: [{ run: aRun({ runId: "run_01A0000000000000000000000" }), activeAttempts: ["att_a", "att_b"] }],
    settings: aSettings(),
  };
}
const checks = (headSha: string, status: "passed" | "failed" | "pending", confirmed = true): RepoInput => ({ kind: "main_checks", headSha, status, failing: status === "failed" ? ["ci/test"] : [], confirmed });
const apply = (c: RepoContext, t: RepoTransition): RepoContext => ({ ...c, repo: t.repo ?? c.repo });

describe("main health: stop the line (FR-044)", () => {
  test("a failing required check on main's head pauses the repository with one Slack message", () => {
    const t = repositoryMachine(ctx(), checks(main1, "failed"))!;
    expect(t.repo).toMatchObject({ paused: true, pausedSince: "2026-11-11T01:00:00.000Z", failingChecks: ["ci/test"], mainCommit: main1 });
    expect(t.intents.map((i) => i.effect)).toEqual(["slack.post"]);
    expect(t.intents[0]!.payload).toMatchObject({ template: "repoPaused", params: { repo: "acme/mono", checks: ["ci/test"], commit: main1, runs: 1 } });
    expect(t.repo?.notification?.slackKey).toBe(t.intents[0]!.key);
    expect(t.decisions).toEqual([expect.objectContaining({ actor: "orchestrator", action: "pause" })]);
  });

  test("a second failure while paused changes nothing", () => {
    const paused = apply(ctx(), repositoryMachine(ctx(), checks(main1, "failed"))!);
    expect(repositoryMachine(paused, checks(main1, "failed"))).toBeUndefined();
  });

  test("green again, confirmed by a fresh read, resumes: a thread reply and the held attempts released", () => {
    const paused = apply(ctx(), repositoryMachine(ctx(), checks(main1, "failed"))!);
    const t = repositoryMachine(paused, checks(main2, "passed"))!;
    expect(t.repo).toMatchObject({ paused: false, pausedSince: null, failingChecks: [], mainCommit: main2, notification: null });
    const reply = t.intents.find((i) => i.effect === "slack.reply")!;
    expect(reply.payload).toMatchObject({ replyTo: paused.repo.notification!.slackKey, template: "mainGreen", params: { commit: main2 } });
    const fanout = t.intents.filter((i) => i.effect === "queue.enqueue");
    expect(fanout).toHaveLength(1);
    expect((fanout[0]!.payload.messages as QueueMessage[]).map((m) => [m.group, m.input.kind])).toEqual([
      ["att:att_a", "control"],
      ["att:att_b", "control"],
    ]);
  });

  test("an unconfirmed green does not resume; pending does nothing", () => {
    const paused = apply(ctx(), repositoryMachine(ctx(), checks(main1, "failed"))!);
    expect(repositoryMachine(paused, checks(main2, "passed", false))).toBeUndefined();
    expect(repositoryMachine(paused, checks(main2, "pending"))).toBeUndefined();
  });

  test("a push to main records the new head", () => {
    const t = repositoryMachine(ctx(), { kind: "main_push", headSha: main2 })!;
    expect(t.repo?.mainCommit).toBe(main2);
    expect(repositoryMachine(apply(ctx(), t), { kind: "main_push", headSha: main2 })).toBeUndefined();
  });
});
