import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { WorkMessage } from "@rovara-orch/core";
import { freshTable } from "@rovara-orch/testkit";
import { routeGithubEvent, type Deps } from "@rovara-orch/workers";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/github/${name}.json`, import.meta.url), "utf8"));
const head = "a".repeat(40);
const attemptId = "att_run_01JTEST0000000000000000000.US1.a1";
const group = `att:${attemptId}`;

let deps: Deps;
let drop: () => Promise<void>;

beforeAll(async () => {
  const t = await freshTable("gh-webhooks");
  drop = t.drop;
  await t.table.transact([
    { kind: "put", item: { pk: "PRLINK#acme/mono#7", sk: "META", attemptId, number: 7 } },
    { kind: "put", item: { pk: `PRHEAD#acme/mono#${head}`, sk: "META", attemptId, number: 7 } },
  ]);
  const github = {
    isReachableFromMain: async (_r: string, sha: string) => sha === "c".repeat(40),
    checksForSha: async () => ({ status: "failed" as const, failing: ["test"] }),
    hasReviewed: async (_r: string, _n: number, sha: string) => sha === head,
    listReviewThreads: async () => [
      { threadId: "PRRT_1", author: "coderabbitai[bot]", body: "Handle null.", path: "src/a.ts", line: 12, commit: head, url: "u1", resolved: false, replies: [] },
      { threadId: "PRRT_2", author: "coderabbitai[bot]", body: "Rename.", path: "src/b.ts", line: 3, commit: head, url: "u2", resolved: false, replies: [{ author: "rovara-app[bot]", body: "Kept: it matches the spec." }] },
      { threadId: "PRRT_3", author: "coderabbitai[bot]", body: "Old.", path: "src/c.ts", line: 1, commit: "0".repeat(40), url: "u3", resolved: false, replies: [] },
    ],
  };
  deps = { table: t.table, repos: t.repos, github, clock: { now: () => new Date() }, config: { channel: "orchestrator" } } as unknown as Deps;
});
afterAll(() => drop());

async function map(event: string, name: string): Promise<WorkMessage[]> {
  const payload = fixture(name);
  const handler = routeGithubEvent(event, payload);
  if (!handler) return [];
  return handler(deps, payload, "d1");
}

describe("GitHub webhooks map to attempt inputs", () => {
  test("pull_request opened and synchronize", async () => {
    expect(await map("pull_request", "pull_request.opened")).toEqual([
      { group, input: { kind: "github", deliveryId: "d1", event: { type: "pr_opened", number: 7, headSha: head, baseRef: "main", repo: "acme/mono", changedFiles: 3 } } },
    ]);
    expect((await map("pull_request", "pull_request.synchronize"))[0]!.input).toMatchObject({ event: { type: "pr_synchronize", headSha: "d".repeat(40), changedFiles: 4 } });
  });

  test("pull_request closed: merged and on main, or closed without merge", async () => {
    expect((await map("pull_request", "pull_request.closed.merged"))[0]!.input).toMatchObject({ event: { type: "merged_on_main", number: 7, mergeCommit: "c".repeat(40) } });
    expect((await map("pull_request", "pull_request.closed.unmerged"))[0]!.input).toMatchObject({ event: { type: "pr_closed", number: 7, merged: false } });
  });

  test("merge queue entry and removal", async () => {
    expect((await map("pull_request", "pull_request.enqueued"))[0]!.input).toMatchObject({ event: { type: "merge_group", status: "entered" } });
    expect((await map("pull_request", "pull_request.dequeued"))[0]!.input).toMatchObject({ event: { type: "merge_group", status: "removed", reason: "conflict" } });
    expect((await map("merge_group", "merge_group.checks_requested"))[0]!.input).toMatchObject({ event: { type: "merge_group", number: 7, status: "entered" } });
    expect((await map("merge_group", "merge_group.destroyed"))[0]!.input).toMatchObject({ event: { type: "merge_group", number: 7, status: "removed", reason: "out_of_date" } });
  });

  test.each(["pull_request_review.submitted", "pull_request_review_comment.created", "pull_request_review_thread.resolved"])(
    "%s becomes the review state of the PR's head, with addressed threads marked",
    async (name) => {
      const event = name.split(".")[0]!;
      const [m] = await map(event, name);
      expect(m!.group).toBe(group);
      const e = (m!.input as { event: { type: string; headSha: string; reviewed: boolean; threads: Array<{ threadId: string; addressed: string | null }> } }).event;
      expect(e).toMatchObject({ type: "review_state", headSha: head, reviewed: true });
      expect(Object.fromEntries(e.threads.map((t) => [t.threadId, t.addressed]))).toEqual({ PRRT_1: null, PRRT_2: "answered", PRRT_3: "fixed" });
    },
  );

  test("check suites, check runs and statuses on a PR head report the combined required checks", async () => {
    for (const [event, name] of [["check_suite", "check_suite.completed"], ["check_run", "check_run.completed"], ["status", "status"]] as const) {
      const [m] = await map(event, name);
      expect(m!.input, name).toMatchObject({ event: { type: "checks", number: 7, headSha: head, scope: "pr", status: "failed", failing: ["test"] } });
    }
  });

  test("events for PRs the orchestrator does not own map to nothing", async () => {
    const other = { ...fixture("pull_request.opened"), number: 99, pull_request: { ...fixture("pull_request.opened").pull_request, number: 99 } };
    expect(await routeGithubEvent("pull_request", other)!(deps, other, "d2")).toEqual([]);
  });
});
