import { describe, expect, test } from "vitest";
import { canMerge, type MergeInputs } from "./merge-gate.js";
import { anAttempt, aSettings } from "./testing/fixtures.js";
import { emptyRepository } from "./model.js";

const head = "h".repeat(40);
function inputs(p: Partial<MergeInputs> = {}): MergeInputs {
  const attempt = anAttempt({
    checkReports: [{ status: "passed", at: "t", text: "ok" }],
    pullRequests: [{ number: 7, url: "https://github.com/acme/mono/pull/7", headSha: head, state: "open", openedAt: "t", changedFiles: 3, baseRef: "main", repo: "acme/mono", mergeCommit: null }],
    review: { headSha: head, reviewedAt: "t", rerequestedAt: null, unresolved: 0, sent: [] },
    ci: { headSha: head, pr: "passed", queue: "none", failing: [] },
  });
  return { attempt, prNumber: 7, dagRepo: "acme/mono", repo: emptyRepository("acme/mono"), settings: aSettings(), ...p };
}
const pr = (i: MergeInputs) => i.attempt.pullRequests[0]!;

describe("canMerge", () => {
  test("all conditions hold", () => {
    expect(canMerge(inputs())).toEqual({ ok: true, failing: [] });
  });

  test.each<[string, (i: MergeInputs) => MergeInputs]>([
    ["not_current_pr", (i) => ({ ...i, prNumber: 8 })],
    ["wrong_repo", (i) => ({ ...i, attempt: { ...i.attempt, pullRequests: [{ ...pr(i), repo: "acme/other" }] } })],
    ["base_not_main", (i) => ({ ...i, attempt: { ...i.attempt, pullRequests: [{ ...pr(i), baseRef: "develop" }] } })],
    ["checks_not_passed", (i) => ({ ...i, attempt: { ...i.attempt, checkReports: [...i.attempt.checkReports, { status: "unknown", at: "t", text: "?" }] } })],
    ["no_changes", (i) => ({ ...i, attempt: { ...i.attempt, pullRequests: [{ ...pr(i), changedFiles: 0 }] } })],
    ["not_reviewed", (i) => ({ ...i, attempt: { ...i.attempt, review: { ...i.attempt.review, headSha: "old" } } })],
    ["unresolved_comments", (i) => ({ ...i, attempt: { ...i.attempt, review: { ...i.attempt.review, unresolved: 2 } } })],
    ["ci_failing_pr", (i) => ({ ...i, attempt: { ...i.attempt, ci: { ...i.attempt.ci, pr: "failed" } } })],
    ["ci_failing_queue", (i) => ({ ...i, attempt: { ...i.attempt, ci: { ...i.attempt.ci, queue: "failed" } } })],
    ["repo_paused", (i) => ({ ...i, repo: { ...i.repo, paused: true } })],
    ["stop_switch", (i) => ({ ...i, settings: aSettings({ stopSwitch: { on: true, by: "op", at: "t", reason: "x" } }) })],
  ])("refuses when %s", (code, change) => {
    const r = canMerge(change(inputs()));
    expect(r.ok).toBe(false);
    expect(r.failing).toContain(code);
  });

  test("CI pending on the PR head is not yet mergeable", () => {
    const i = inputs();
    expect(canMerge({ ...i, attempt: { ...i.attempt, ci: { ...i.attempt.ci, pr: "pending" } } }).failing).toContain("ci_failing_pr");
  });
});
