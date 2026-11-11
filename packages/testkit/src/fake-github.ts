import type { GithubApi, PullRequestInfo, ReviewThreadInfo } from "@rovara-orch/workers";

/** A webhook the fake sends: event name and GitHub-shaped payload. */
export interface Webhook {
  event: string;
  payload: Record<string, unknown>;
}

interface Commit {
  sha: string;
  files: string[];
}

interface Thread {
  threadId: string;
  author: string;
  body: string;
  path: string | null;
  line: number | null;
  commit: string;
  resolved: boolean;
  replies: Array<{ author: string; body: string }>;
}

interface Pull {
  number: number;
  nodeId: string;
  title: string;
  headRef: string;
  headSha: string;
  baseSha: string;
  files: string[];
  state: "open" | "closed" | "merged";
  mergeCommit: string | null;
  threads: Thread[];
  reviewedHeads: Set<string>;
  reviewRound: number;
  queued: boolean;
}

export interface FakeGithubOptions {
  repo?: string;
  reviewer?: string;
  /** CI result for a PR head or a merge-queue run. Default: passed. */
  ci?: (pull: { number: number; headRef: string; headSha: string }, scope: "pr" | "merge_queue") => "passed" | "failed";
  /** Comments the review tool leaves on a head, by review round (0 = first review). Default: none. */
  reviewComments?: (pull: { number: number; headRef: string }, round: number) => Array<{ path: string; line: number; body: string }>;
  /** When false, the review tool never reviews (FR-046 tests). */
  reviewToolActive?: boolean;
  /** Files readable at any ref (the spec folder). */
  files?: Record<string, string>;
}

let shaCounter = 0;
const newSha = () => (++shaCounter).toString(16).padStart(40, "0");

/** In-memory GitHub for one repository, implementing the workers' GithubApi port and sending webhooks. */
export class FakeGithub implements GithubApi {
  readonly repo: string;
  readonly reviewer: string;
  readonly main: Commit[] = [{ sha: newSha(), files: [] }];
  readonly pulls = new Map<number, Pull>();
  readonly merges: Array<{ number: number; mergeCommit: string; headSha: string }> = [];
  readonly enqueueCalls: Array<{ number: number; expectedHeadOid: string }> = [];
  mainStatus: "passed" | "failed" = "passed";
  private next = 1;
  private threadCounter = 0;
  private sink: (w: Webhook) => void = () => {};

  constructor(private readonly opts: FakeGithubOptions = {}) {
    this.repo = opts.repo ?? "acme/mono";
    this.reviewer = opts.reviewer ?? "coderabbitai[bot]";
  }

  onWebhook(sink: (w: Webhook) => void): void {
    this.sink = sink;
  }

  private emit(event: string, payload: Record<string, unknown>): void {
    this.sink({ event, payload: { ...payload, repository: { full_name: this.repo, default_branch: "main" } } });
  }

  get mainHeadSha(): string {
    return this.main.at(-1)!.sha;
  }

  private pullPayload(p: Pull) {
    return {
      number: p.number,
      node_id: p.nodeId,
      title: p.title,
      html_url: `https://github.com/${this.repo}/pull/${p.number}`,
      state: p.state === "open" ? "open" : "closed",
      merged: p.state === "merged",
      merge_commit_sha: p.mergeCommit,
      changed_files: p.files.length,
      head: { sha: p.headSha, ref: p.headRef },
      base: { ref: "main", sha: p.baseSha, repo: { full_name: this.repo } },
    };
  }

  // ---------- what the fake Rovara does ----------

  openPull(input: { headRef: string; title: string; files: string[] }): { number: number; url: string } {
    const number = this.next++;
    const p: Pull = {
      number,
      nodeId: `PR_${number}`,
      title: input.title,
      headRef: input.headRef,
      headSha: newSha(),
      baseSha: this.mainHeadSha,
      files: input.files,
      state: "open",
      mergeCommit: null,
      threads: [],
      reviewedHeads: new Set(),
      reviewRound: 0,
      queued: false,
    };
    this.pulls.set(number, p);
    this.emit("pull_request", { action: "opened", number, pull_request: this.pullPayload(p) });
    this.afterHead(p);
    return { number, url: `https://github.com/${this.repo}/pull/${number}` };
  }

  /** Rovara pushes a commit: fixes for review comments, or an update from main. */
  pushToPull(number: number, opts: { fromMain?: boolean; fixesThreads?: boolean } = {}): void {
    const p = this.pull(number);
    if (opts.fixesThreads) {
      for (const t of p.threads) if (!t.resolved && !t.replies.length) t.replies.push({ author: "rovara[bot]", body: "Fixed in the next commit." });
    }
    p.headSha = newSha();
    if (opts.fromMain) p.baseSha = this.mainHeadSha;
    this.emit("pull_request", { action: "synchronize", number, pull_request: this.pullPayload(p) });
    this.afterHead(p);
  }

  /** CI and the review tool react to a new head. */
  private afterHead(p: Pull): void {
    const ci = this.opts.ci?.(p, "pr") ?? "passed";
    this.emit("check_suite", {
      action: "completed",
      check_suite: { head_sha: p.headSha, head_branch: p.headRef, conclusion: ci === "passed" ? "success" : "failure", pull_requests: [{ number: p.number }] },
    });
    if (this.opts.reviewToolActive !== false) this.review(p);
  }

  private review(p: Pull): void {
    const comments = this.opts.reviewComments?.(p, p.reviewRound) ?? [];
    p.reviewRound++;
    for (const c of comments) {
      p.threads.push({ threadId: `RT_${++this.threadCounter}`, author: this.reviewer, body: c.body, path: c.path, line: c.line, commit: p.headSha, resolved: false, replies: [] });
    }
    p.reviewedHeads.add(p.headSha);
    this.emit("pull_request_review", {
      action: "submitted",
      review: { user: { login: this.reviewer }, commit_id: p.headSha, state: comments.length ? "commented" : "approved" },
      pull_request: this.pullPayload(p),
    });
  }

  private conflicts(p: Pull): boolean {
    const idx = this.main.findIndex((c) => c.sha === p.baseSha);
    const since = this.main.slice(idx + 1);
    return since.some((c) => c.files.some((f) => p.files.includes(f)));
  }

  breakMain(check = "ci/test"): void {
    this.mainStatus = "failed";
    this.main.push({ sha: newSha(), files: ["broken.txt"] });
    this.emit("push", { ref: "refs/heads/main", after: this.mainHeadSha, head_commit: { id: this.mainHeadSha } });
    this.emit("check_suite", { action: "completed", check_suite: { head_sha: this.mainHeadSha, head_branch: "main", conclusion: "failure", app: { name: check }, pull_requests: [] } });
  }

  fixMain(): void {
    this.mainStatus = "passed";
    this.main.push({ sha: newSha(), files: ["broken.txt"] });
    this.emit("push", { ref: "refs/heads/main", after: this.mainHeadSha, head_commit: { id: this.mainHeadSha } });
    this.emit("check_suite", { action: "completed", check_suite: { head_sha: this.mainHeadSha, head_branch: "main", conclusion: "success", pull_requests: [] } });
  }

  /** A person merges or closes a PR by hand (spec Edge Cases). */
  closeByHand(number: number, merge: boolean): void {
    const p = this.pull(number);
    if (merge) this.mergeNow(p);
    else {
      p.state = "closed";
      this.emit("pull_request", { action: "closed", number, pull_request: this.pullPayload(p) });
    }
  }

  private mergeNow(p: Pull): void {
    const commit = { sha: newSha(), files: p.files };
    this.main.push(commit);
    p.state = "merged";
    p.mergeCommit = commit.sha;
    p.queued = false;
    this.merges.push({ number: p.number, mergeCommit: commit.sha, headSha: p.headSha });
    this.emit("pull_request", { action: "closed", number: p.number, pull_request: this.pullPayload(p) });
    this.emit("push", { ref: "refs/heads/main", after: commit.sha, head_commit: { id: commit.sha } });
    this.emit("check_suite", { action: "completed", check_suite: { head_sha: commit.sha, head_branch: "main", conclusion: this.mainStatus === "passed" ? "success" : "failure", pull_requests: [] } });
  }

  private pull(number: number): Pull {
    const p = this.pulls.get(number);
    if (!p) throw new Error(`no pull request #${number}`);
    return p;
  }

  // ---------- GithubApi ----------

  async mainHead(): Promise<string> {
    return this.mainHeadSha;
  }

  async isReachableFromMain(_repo: string, sha: string): Promise<boolean> {
    return this.main.some((c) => c.sha === sha);
  }

  async commitOnRemote(_repo: string, sha: string): Promise<boolean> {
    return this.main.some((c) => c.sha === sha) || [...this.pulls.values()].some((p) => p.headSha === sha);
  }

  async getPull(_repo: string, number: number): Promise<PullRequestInfo> {
    const p = this.pull(number);
    return {
      number,
      url: `https://github.com/${this.repo}/pull/${number}`,
      headSha: p.headSha,
      state: p.state,
      baseRef: "main",
      repo: this.repo,
      changedFiles: p.files.length,
      mergeCommit: p.mergeCommit,
      nodeId: p.nodeId,
    };
  }

  async listReviewThreads(_repo: string, number: number, reviewer: string): Promise<ReviewThreadInfo[]> {
    return this.pull(number)
      .threads.filter((t) => t.author === reviewer)
      .map((t) => ({ threadId: t.threadId, author: t.author, body: t.body, path: t.path, line: t.line, commit: t.commit, url: `https://github.com/${this.repo}/pull/${number}#${t.threadId}`, resolved: t.resolved, replies: [...t.replies] }));
  }

  async hasReviewed(_repo: string, number: number, headSha: string): Promise<boolean> {
    return this.pull(number).reviewedHeads.has(headSha);
  }

  async resolveThread(threadId: string): Promise<void> {
    for (const p of this.pulls.values()) {
      const t = p.threads.find((x) => x.threadId === threadId);
      if (t && !t.resolved) {
        t.resolved = true;
        this.emit("pull_request_review_thread", { action: "resolved", thread: { node_id: threadId }, pull_request: this.pullPayload(p) });
      }
    }
  }

  async comment(_repo: string, number: number, body: string): Promise<void> {
    const p = this.pull(number);
    if (body.trim() === "@coderabbitai review" && this.opts.reviewToolActive !== false) this.review(p);
  }

  async enqueue(_repo: string, pullNodeId: string, expectedHeadOid: string): Promise<void> {
    const p = [...this.pulls.values()].find((x) => x.nodeId === pullNodeId);
    if (!p) throw new Error(`no pull request ${pullNodeId}`);
    this.enqueueCalls.push({ number: p.number, expectedHeadOid });
    if (p.state === "merged") return; // already merged: a repeat is a no-op
    if (p.headSha !== expectedHeadOid) throw new Error(`head changed: expected ${expectedHeadOid}, is ${p.headSha}`);
    if (p.queued) return;
    p.queued = true;
    if (this.conflicts(p)) {
      p.queued = false;
      this.emit("pull_request", { action: "dequeued", number: p.number, reason: "MERGE_CONFLICT", pull_request: this.pullPayload(p) });
      return;
    }
    this.emit("pull_request", { action: "enqueued", number: p.number, pull_request: this.pullPayload(p) });
    const ci = this.opts.ci?.(p, "merge_queue") ?? "passed";
    if (ci === "failed") {
      p.queued = false;
      this.emit("pull_request", { action: "dequeued", number: p.number, reason: "CI_FAILURE", pull_request: this.pullPayload(p) });
      return;
    }
    this.mergeNow(p);
  }

  async closePull(_repo: string, number: number): Promise<void> {
    const p = this.pull(number);
    if (p.state !== "open") return;
    p.state = "closed";
    this.emit("pull_request", { action: "closed", number, pull_request: this.pullPayload(p) });
  }

  async readFile(_repo: string, path: string): Promise<string | null> {
    return this.opts.files?.[path] ?? null;
  }

  async requiredChecksOnMain(): Promise<{ headSha: string; status: "passed" | "failed" | "pending"; failing: string[] }> {
    return { headSha: this.mainHeadSha, status: this.mainStatus, failing: this.mainStatus === "failed" ? ["ci/test"] : [] };
  }
}
