// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { NodeView, RunSummary, RunView, StatusApi, TraceStep } from "../api.js";
import { NodePage } from "./NodePage.js";
import { RunPage } from "./RunPage.js";
import { RunsPage } from "./RunsPage.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const STATES = ["waiting", "eligible", "running", "pr_open", "in_merge_queue", "merged", "escalated", "skipped"] as const;

function bigRun(): RunView {
  const nodes = Array.from({ length: 1000 }, (_, i) => ({
    nodeId: `N${String(i).padStart(4, "0")}`,
    title: i === 734 ? "Password reset email" : `Story ${i}`,
    state: STATES[i % STATES.length]!,
    waitingFor: i % STATES.length === 1 ? { reason: "files", detail: "src/shared.ts (held by N0002)" } : null,
    attempt: i % 3 ? 1 : null,
    rovaraTaskUrl: null,
    pullRequests: i === 734 ? [{ number: 734, url: "https://github.com/acme/mono/pull/734", state: "open" }] : [],
  }));
  const counts: Record<string, number> = {};
  for (const n of nodes) counts[n.state] = (counts[n.state] ?? 0) + 1;
  return { runId: "run_1", dagId: "dag_1", repo: "acme/mono", state: "running", concurrencyLimit: 200, costLimitUsd: 500, costUsd: 123.45, counts, actingFor: "dev_alice", startedAt: "2026-11-11T00:00:00.000Z", endedAt: null, pausedFor: null, nodes, notifications: [] };
}

const nodeView = (over: Partial<NodeView> = {}): NodeView => ({
  runId: "run_1",
  nodeId: "US2",
  title: "Log in",
  kind: "story",
  state: "pr_open",
  waitingFor: null,
  attempts: [
    {
      attemptId: "att_1",
      n: 1,
      phase: "abandoned",
      outcome: "abandoned",
      outcomeReason: "checks failed after 2 fix requests",
      rovaraTaskUrl: "https://rovara.test/tasks/a1",
      checkReports: [{ status: "failed", at: "t", text: "lint" }],
      pullRequests: [],
      questions: [],
      reviewComments: [],
    },
    {
      attemptId: "att_2",
      n: 2,
      phase: "pr_open",
      outcome: null,
      outcomeReason: null,
      rovaraTaskUrl: "https://rovara.test/tasks/a2",
      checkReports: [{ status: "passed", at: "t", text: "ok" }],
      pullRequests: [{ number: 9, url: "https://github.com/acme/mono/pull/9", state: "open" }],
      questions: [{ eventId: "e1", question: "24h or 7d sessions?", answer: "Use 24h, as the spec says.", answeredBy: "anthropic.claude-opus-5-5", at: "t" }],
      reviewComments: [{ threadId: "PRRT_1", path: "src/login.ts", line: 40, body: "Rate-limit failed logins.", url: "https://github.com/acme/mono/pull/9#r1", round: 1, resolution: "fixed" }],
    },
  ],
  decisions: [{ at: "2026-11-11T00:05:00.000Z", actor: "orchestrator", action: "approve", reason: "plan approved" }],
  unblockedBySkip: ["US1"],
  ...over,
});

function fakeApi(p: { run?: RunView; node?: NodeView; trace?: (after: number | null) => { steps: TraceStep[]; next: number | null; live: boolean } } = {}): StatusApi {
  return {
    listRuns: async (): Promise<RunSummary[]> => [{ runId: "run_1", dagId: "dag_1", state: "running", counts: { running: 3, merged: 7 }, costUsd: 12.5, startedAt: "2026-11-11T00:00:00.000Z", actingFor: "dev_alice" }],
    getRun: async () => p.run ?? bigRun(),
    getNode: async () => p.node ?? nodeView(),
    getTrace: async (_r, _n, after) => (p.trace ? p.trace(after) : { steps: [], next: null, live: false }),
  };
}

describe("runs page", () => {
  test("lists runs with their state, counts and cost", async () => {
    render(<RunsPage api={fakeApi()} />);
    const row = await screen.findByText("run_1");
    expect(row.closest("tr")!.textContent).toMatch(/running.*\$12\.50/);
  });
});

describe("run page", () => {
  test("shows the counts per node state and the cost", async () => {
    render(<RunPage api={fakeApi()} runId="run_1" />);
    const summary = await screen.findByRole("region", { name: "Run summary" });
    expect(within(summary).getByText("$123.45 of $500")).toBeTruthy();
    expect(within(summary).getByText("merged").parentElement!.textContent).toContain("125");
    expect(within(summary).getByText("escalated").parentElement!.textContent).toContain("125");
  });

  test("finds a node among 1000 by id, by title, or by state (SC-008)", async () => {
    render(<RunPage api={fakeApi()} runId="run_1" />);
    await screen.findByRole("region", { name: "Run summary" });
    const search = screen.getByRole("searchbox", { name: "Find a node" });
    fireEvent.change(search, { target: { value: "password reset" } });
    let rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("N0734");
    expect(within(rows[0]!).getByRole("link", { name: "#734" }).getAttribute("href")).toBe("https://github.com/acme/mono/pull/734");

    fireEvent.change(search, { target: { value: "N0042" } });
    expect(screen.getAllByRole("row").slice(1).map((r) => r.textContent)).toEqual([expect.stringContaining("N0042")]);

    fireEvent.change(search, { target: { value: "" } });
    fireEvent.change(screen.getByRole("combobox", { name: "State" }), { target: { value: "eligible" } });
    rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(125);
    expect(rows[0]!.textContent).toContain("files");
  });
});

describe("node page", () => {
  test("shows attempts, PRs with their states, questions and answers, review comments, decisions, and a skipped dependency", async () => {
    render(<NodePage api={fakeApi()} runId="run_1" nodeId="US2" />);
    await screen.findByText("Log in");
    expect(screen.getByText(/Attempt 1/).textContent).toContain("abandoned");
    expect(screen.getByText("checks failed after 2 fix requests")).toBeTruthy();
    expect(screen.getByRole("link", { name: "#9" }).closest("li")!.textContent).toContain("open");
    expect(screen.getByText("24h or 7d sessions?")).toBeTruthy();
    expect(screen.getByText("Use 24h, as the spec says.")).toBeTruthy();
    expect(screen.getByText("Rate-limit failed logins.").closest("li")!.textContent).toMatch(/src\/login\.ts:40.*fixed/);
    expect(screen.getByText("plan approved").closest("li")!.textContent).toMatch(/orchestrator.*approve/);
    expect(screen.getByText(/unblocked by a skipped dependency/i).textContent).toContain("US1");
  });

  test("new trace steps appear without a reload while the node is live", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    const trace = (after: number | null) => {
      calls++;
      if (after === null) return { steps: [{ sequence: 1, at: "2026-11-11T00:01:00.000Z", kind: "progress", payload: { text: "Writing the code." } }], next: null, live: true };
      if (calls >= 3) return { steps: [{ sequence: 2, at: "2026-11-11T00:01:05.000Z", kind: "check_report", payload: { status: "passed", text: "Checks passed (12 project checks)." } }], next: null, live: false };
      return { steps: [], next: null, live: true };
    };
    render(<NodePage api={fakeApi({ trace })} runId="run_1" nodeId="US2" />);
    await screen.findByText("Writing the code.");
    expect(screen.queryByText("Checks passed (12 project checks).")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(4100));
    expect(await screen.findByText("Checks passed (12 project checks).")).toBeTruthy();
    expect(screen.getByText(/only conversation-level events/i)).toBeTruthy();
    const after = calls;
    await act(() => vi.advanceTimersByTimeAsync(6000));
    expect(calls, "polling stops once the attempt is no longer live").toBe(after);
  });

  test("no page offers an action control", async () => {
    const { unmount } = render(<RunsPage api={fakeApi()} />);
    await screen.findByText("run_1");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    unmount();
    render(<RunPage api={fakeApi()} runId="run_1" />);
    await screen.findByRole("region", { name: "Run summary" });
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    cleanup();
    render(<NodePage api={fakeApi()} runId="run_1" nodeId="US2" />);
    await screen.findByText("Log in");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(document.querySelectorAll("form")).toHaveLength(0);
  });
});
