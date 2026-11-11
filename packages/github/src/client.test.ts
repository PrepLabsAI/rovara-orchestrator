import { describe, expect, test } from "vitest";
import type { GithubClients } from "./app.js";
import { GithubAppApi } from "./client.js";
import { prNumberFromUrl } from "./pull-requests.js";

/** A stub of Octokit's REST and GraphQL calls, recording each one. */
function stub(rest: Record<string, Record<string, (args: Record<string, unknown>) => unknown>>, gql: (q: string, v: Record<string, unknown>) => unknown = () => ({})) {
  const calls: Array<{ fn: string; args: unknown }> = [];
  const restProxy = Object.fromEntries(
    Object.entries(rest).map(([ns, fns]) => [
      ns,
      Object.fromEntries(Object.entries(fns).map(([name, f]) => [name, async (args: Record<string, unknown>) => (calls.push({ fn: `${ns}.${name}`, args }), { data: await f(args) })])),
    ]),
  );
  const graphql = async (q: string, v: Record<string, unknown>) => (calls.push({ fn: "graphql", args: { q, v } }), gql(q, v));
  return { api: new GithubAppApi({ rest: restProxy, graphql } as unknown as GithubClients), calls };
}

const notFound = () => {
  throw Object.assign(new Error("Not Found"), { status: 404 });
};

describe("GithubAppApi", () => {
  test("reads main's head and whether a commit is on main", async () => {
    const { api } = stub({
      repos: {
        getBranch: () => ({ commit: { sha: "abc" } }),
        compareCommitsWithBasehead: ({ basehead }) => ({ status: String(basehead).startsWith("old") ? "ahead" : "diverged" }),
      },
    });
    expect(await api.mainHead("acme/mono")).toBe("abc");
    expect(await api.isReachableFromMain("acme/mono", "old1")).toBe(true);
    expect(await api.isReachableFromMain("acme/mono", "branchy")).toBe(false);
  });

  test("a PR's head, state, base and changed files; closing a closed PR is a no-op", async () => {
    let state = "open";
    const { api, calls } = stub({
      pulls: {
        get: () => ({ number: 7, html_url: "https://github.com/acme/mono/pull/7", head: { sha: "h" }, merged: false, state, base: { ref: "main", repo: { full_name: "acme/mono" } }, changed_files: 2, merge_commit_sha: null, node_id: "PR_7" }),
        update: () => ((state = "closed"), {}),
      },
    });
    expect(await api.getPull("acme/mono", 7)).toMatchObject({ number: 7, headSha: "h", state: "open", baseRef: "main", changedFiles: 2, nodeId: "PR_7" });
    await api.closePull("acme/mono", 7);
    await api.closePull("acme/mono", 7);
    expect(calls.filter((c) => c.fn === "pulls.update")).toHaveLength(1);
  });

  test("the PR number comes from Rovara's pr URL", () => {
    expect(prNumberFromUrl("https://github.com/acme/mono/pull/42")).toBe(42);
    expect(prNumberFromUrl("https://github.com/acme/mono/pull/42/files")).toBe(42);
    expect(prNumberFromUrl("https://example.com/pull/42")).toBeNull();
  });

  test("review threads are filtered by the review tool's login, with replies", async () => {
    const { api } = stub({}, () => ({
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              { id: "T1", isResolved: false, path: "a.ts", line: 3, comments: { nodes: [{ author: { login: "coderabbitai[bot]" }, body: "fix", url: "u1", commit: { oid: "c1" } }, { author: { login: "rovara[bot]" }, body: "done", url: "u2", commit: null }] } },
              { id: "T2", isResolved: false, path: null, line: null, comments: { nodes: [{ author: { login: "someone" }, body: "q", url: "u3", commit: null }] } },
            ],
          },
        },
      },
    }));
    const threads = await api.listReviewThreads("acme/mono", 7, "coderabbitai[bot]");
    expect(threads).toEqual([{ threadId: "T1", author: "coderabbitai[bot]", body: "fix", path: "a.ts", line: 3, commit: "c1", url: "u1", resolved: false, replies: [{ author: "rovara[bot]", body: "done" }] }]);
  });

  test("enqueue sends the expected head; resolve and comment call GitHub", async () => {
    const { api, calls } = stub({ issues: { createComment: () => ({}) } });
    await api.enqueue("acme/mono", "PR_7", "h1");
    await api.resolveThread("T1");
    await api.comment("acme/mono", 7, "@coderabbitai review");
    const gql = calls.filter((c) => c.fn === "graphql").map((c) => c.args as { q: string; v: Record<string, unknown> });
    expect(gql[0]!.q).toContain("enqueuePullRequest");
    expect(gql[0]!.v).toEqual({ id: "PR_7", head: "h1" });
    expect(gql[1]!.q).toContain("resolveReviewThread");
    expect(calls.find((c) => c.fn === "issues.createComment")?.args).toMatchObject({ issue_number: 7, body: "@coderabbitai review" });
  });

  test("checks: a failed suite or status fails; an incomplete one is pending", async () => {
    const make = (suites: unknown[], statuses: unknown[]) =>
      stub({ checks: { listSuitesForRef: () => ({ check_suites: suites }) }, repos: { getCombinedStatusForRef: () => ({ statuses }) } }).api;
    expect(await make([{ id: 1, status: "completed", conclusion: "success" }], []).checksForSha("acme/mono", "s")).toEqual({ status: "passed", failing: [] });
    expect(await make([{ id: 1, status: "completed", conclusion: "failure", app: { name: "ci" } }], []).checksForSha("acme/mono", "s")).toEqual({ status: "failed", failing: ["ci"] });
    expect(await make([{ id: 1, status: "in_progress", conclusion: null }], []).checksForSha("acme/mono", "s")).toMatchObject({ status: "pending" });
  });

  test("a missing file is null; a missing commit is not on the remote", async () => {
    const { api } = stub({ repos: { getContent: notFound, listBranchesForHeadCommit: notFound } });
    expect(await api.readFile("acme/mono", "nope.md", "main")).toBeNull();
    expect(await api.commitOnRemote("acme/mono", "dead")).toBe(false);
  });
});
