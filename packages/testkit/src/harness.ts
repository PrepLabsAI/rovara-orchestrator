import {
  DEFAULT_RETRY,
  DEFAULT_SETTINGS,
  newId,
  type Dag,
  type DagNode,
  type NodeRunState,
  type QueueMessage,
  type RetryLimits,
  type Run,
  type Settings,
} from "@rovara-orch/core";
import { sign, newSecret } from "@rovara-orch/rovara";
import { signGithubBody } from "@rovara-orch/github";
import {
  encodeDag,
  encodeDagNode,
  encodeNode,
  encodeRun,
  keys,
  settingsFields,
  versionedWrite,
  type Repositories,
  type Table,
} from "@rovara-orch/store";
import {
  consume,
  DEFAULT_MACHINES,
  EXECUTORS,
  handleGithubEvent,
  handleRovaraEvent,
  runIntent,
  runSweep,
  type Deps,
  type Executor,
  type Machines,
} from "@rovara-orch/workers";
import type { Intent } from "@rovara-orch/core";
import { FakeClock } from "./clock.js";
import { freshTable } from "./dynamo.js";
import { FaultCounts, FaultyPipe, NO_FAULTS, seeded, type FaultKind, type FaultRates } from "./faults.js";
import { FakeGithub, type FakeGithubOptions, type Webhook } from "./fake-github.js";
import { FakeModel, type ModelScript } from "./fake-model.js";
import { FakeRovara, type Behaviour, type OutgoingEvent } from "./fake-rovara.js";
import { FakeSlack } from "./fake-slack.js";

export interface HarnessOptions {
  name?: string;
  seed?: number;
  /** Faults on Rovara callbacks and GitHub webhooks. */
  faults?: FaultRates;
  /**
   * Crash probabilities at each boundary: after an ingress commits but before it answers (the
   * sender retries), after the consumer commits but before it acknowledges (redelivery), and after
   * an effect runs but before it is marked done (re-run).
   */
  crash?: { ingress?: number; consume?: number; intent?: number };
  behaviours?: Record<string, Behaviour>;
  github?: FakeGithubOptions;
  model?: ModelScript[];
  operatorIsAdmin?: boolean;
  machines?: Machines;
  executors?: Record<string, Executor>;
  settings?: Partial<Settings>;
}

export type NodeSeed = Partial<DagNode> & { nodeId: string };

const QUEUE_DEDUP_MS = 5 * 60_000;

/** The whole orchestrator, in one process, against fakes and DynamoDB Local. */
export class Harness {
  readonly clock = new FakeClock();
  readonly counts = new FaultCounts();
  readonly github: FakeGithub;
  readonly rovara: FakeRovara;
  readonly slack = new FakeSlack();
  readonly model: FakeModel;
  readonly rovaraSecret = newSecret();
  readonly githubSecret = "gh-webhook-secret";
  readonly deps: Deps;
  readonly queues = new Map<string, QueueMessage[]>();
  private readonly seenInputs = new Map<string, number>();
  private readonly rng: () => number;
  private readonly rovaraPipe: FaultyPipe<OutgoingEvent>;
  private readonly githubPipe: FaultyPipe<Webhook & { deliveryId: string }>;
  private readonly executors: Record<string, Executor>;
  private deliveryCounter = 0;
  /** Every queue message ever consumed with its outcome, for assertions. */
  readonly consumed: Array<{ inputId: string; outcome: string }> = [];
  /** Effects the table stream does not deliver for now (the sweep's re-drive still runs them). */
  private readonly held = new Set<string>();
  /** One-shot crashes after the consumer commits a matching message, before it acknowledges. */
  private readonly crashes: Array<(m: QueueMessage) => boolean> = [];

  private constructor(
    readonly table: Table,
    readonly repos: Repositories,
    readonly drop: () => Promise<void>,
    private readonly opts: HarnessOptions,
  ) {
    this.rng = seeded(opts.seed ?? 1);
    const rates = opts.faults ?? NO_FAULTS;
    this.rovaraPipe = new FaultyPipe(this.rng, rates, this.counts);
    this.githubPipe = new FaultyPipe(this.rng, rates, this.counts);
    this.github = new FakeGithub(opts.github);
    this.rovara = new FakeRovara(this.github, opts.behaviours ?? {});
    this.model = new FakeModel(opts.model);
    this.rovara.onEvent((e) => this.rovaraPipe.push(e));
    this.github.onWebhook((w) => this.githubPipe.push({ ...w, deliveryId: `d-${++this.deliveryCounter}` }));
    const base = opts.executors ?? EXECUTORS;
    const crashP = opts.crash?.intent ?? 0;
    this.executors = Object.fromEntries(
      Object.entries(base).map(([effect, ex]) => [
        effect,
        (async (intent, deps) => {
          const r = await ex(intent, deps);
          if (crashP && this.rng() < crashP) {
            this.counts.add("restart");
            throw new Error("process stopped after the effect, before mark-done");
          }
          return r;
        }) as Executor,
      ]),
    );
    this.deps = {
      table,
      repos,
      clock: this.clock,
      queue: { send: async (msgs) => msgs.forEach((m) => this.enqueue(m)) },
      rovara: this.rovara,
      github: this.github,
      slack: this.slack,
      answerer: this.model,
      config: { rovaraTenant: "test", rovaraSpace: "mono", channel: "orchestrator", statusPageUrl: "https://status.test" },
      operators: { isRovaraAdmin: async () => !!opts.operatorIsAdmin },
    };
  }

  static async create(opts: HarnessOptions = {}): Promise<Harness> {
    const { table, repos, drop } = await freshTable(opts.name ?? "harness");
    const h = new Harness(table, repos, drop, opts);
    const settings: Settings = { ...DEFAULT_SETTINGS, notificationChannel: "C-NOTIFY", ...opts.settings, version: 0 };
    await table.transact([versionedWrite(keys.settings(), settingsFields(settings), 0)]);
    return h;
  }

  // ---------- setup ----------

  async seedDag(nodes: NodeSeed[], dag: Partial<Dag> = {}): Promise<string> {
    const dagId = dag.dagId ?? newId("dag");
    const d: Dag = {
      dagId,
      hash: `sha256:${"0".repeat(56)}${dagId.slice(-8).toLowerCase().padStart(8, "0")}`,
      repo: this.github.repo,
      commit: this.github.mainHeadSha,
      specDir: "specs/001-test",
      docs: { spec: "specs/001-test/spec.md" },
      feature: "Test",
      unit: "story",
      nodeCount: nodes.length,
      edgeCount: nodes.reduce((n, x) => n + (x.dependsOn?.length ?? 0), 0),
      importedAt: this.clock.now().toISOString(),
      importedBy: "dev_op",
      ...dag,
    };
    await this.table.transact([
      { kind: "put", item: encodeDag(d) },
      ...nodes.map((n, i) => ({
        kind: "put" as const,
        item: encodeDagNode({
          dagId,
          title: n.nodeId,
          kind: "story",
          priority: "P1",
          mvp: false,
          files: [`src/${n.nodeId.toLowerCase()}.ts`],
          tasks: [{ id: `T${i}`, title: `Do ${n.nodeId}`, text: `- [ ] T${i} Do ${n.nodeId}`, ref: `specs/001-test/tasks.md#T${i}`, files: [] }],
          dependsOn: [],
          doneAtImport: false,
          order: i,
          ...n,
        }),
      })),
    ]);
    return dagId;
  }

  async startRun(dagId: string, o: { concurrency?: number; costLimitUsd?: number; retry?: Partial<RetryLimits>; operator?: string } = {}): Promise<string> {
    const dagNodes = await this.repos.getDagNodes(dagId);
    const runId = newId("run");
    const now = this.clock.now().toISOString();
    const nodes: NodeRunState[] = dagNodes.map((n) => ({
      runId,
      nodeId: n.nodeId,
      state: n.doneAtImport ? "merged" : "waiting",
      waitingFor: null,
      currentAttempt: null,
      attempts: 0,
      prUpdates: 0,
      reviewRounds: 0,
      mergeCommit: null,
      escalation: null,
      skippedBy: null,
      unblockedBySkip: [],
      version: 1,
    }));
    const run: Run = {
      runId,
      dagId,
      repo: this.github.repo,
      state: "running",
      concurrencyLimit: o.concurrency ?? 10,
      costLimitUsd: o.costLimitUsd ?? 100,
      retry: { ...DEFAULT_RETRY, ...o.retry },
      costUsd: 0,
      counts: { waiting: nodes.filter((n) => n.state === "waiting").length, merged: nodes.filter((n) => n.state === "merged").length },
      startedBy: o.operator ?? "dev_op",
      actingFor: o.operator ?? "dev_op",
      startedAt: now,
      endedAt: null,
      pausedFor: null,
      tracesExpireSetAt: null,
      version: 1,
    };
    await this.table.transact([
      { kind: "put", item: encodeRun(run) },
      { kind: "put", item: { ...keys.dagActiveRun(dagId), runId }, ifNotExists: true },
      ...nodes.map((n) => ({ kind: "put" as const, item: encodeNode(n) })),
    ]);
    this.enqueue({ group: `run:${runId}`, input: { kind: "run_start" }, inputId: `run_start:${runId}` });
    this.enqueue({ group: `repo:${run.repo}`, input: { kind: "schedule" }, inputId: `start-sched:${runId}` });
    return runId;
  }

  // ---------- the loop ----------

  private enqueue(m: QueueMessage): void {
    const seenAt = this.seenInputs.get(m.inputId);
    const now = this.clock.now().getTime();
    if (seenAt !== undefined && now - seenAt < QUEUE_DEDUP_MS) return; // SQS FIFO deduplication window
    this.seenInputs.set(m.inputId, now);
    const q = this.queues.get(m.group) ?? [];
    q.push(m);
    this.queues.set(m.group, q);
  }

  get queueDepth(): number {
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }

  private async deliverCallbacks(): Promise<boolean> {
    let did = false;
    const crashP = this.opts.crash?.ingress ?? 0;
    for (const e of this.rovaraPipe.take()) {
      did = true;
      if (this.rovaraPipe.dropped()) {
        this.rovaraPipe.retryLater(e);
        continue;
      }
      const body = JSON.stringify(e.body);
      const r = await handleRovaraEvent(this.deps, this.rovaraSecret, { headers: { ...sign(this.rovaraSecret, e.id, this.clock.now(), body) }, body });
      if (r.status !== 200) throw new Error(`Rovara ingress answered ${r.status}: ${r.body}`);
      if (crashP && this.rng() < crashP) {
        this.counts.add("restart");
        this.rovaraPipe.retryLater(e); // committed, but Rovara never saw the 2xx
      }
    }
    for (const w of this.githubPipe.take()) {
      did = true;
      if (this.githubPipe.dropped()) {
        this.githubPipe.retryLater(w);
        continue;
      }
      const body = JSON.stringify(w.payload);
      const r = await handleGithubEvent(this.deps, this.githubSecret, {
        headers: { "x-github-event": w.event, "x-github-delivery": w.deliveryId, "x-hub-signature-256": signGithubBody(this.githubSecret, body) },
        body,
      });
      if (r.status !== 200) throw new Error(`GitHub ingress answered ${r.status}: ${r.body}`);
      if (crashP && this.rng() < crashP) {
        this.counts.add("restart");
        this.githubPipe.retryLater(w);
      }
    }
    return did;
  }

  /** The table stream: run every pending intent that is due. */
  private async runPendingIntents(): Promise<boolean> {
    const now = this.clock.now().toISOString();
    const due = (await this.table.queryIndex<Intent>("PENDING_INTENT", { upTo: `${now}#￿` })).filter((i) => !this.held.has(i.effect));
    for (const i of due) await runIntent(this.deps, i, this.executors);
    return due.length > 0;
  }

  private async consumeSome(max = 20): Promise<boolean> {
    let did = false;
    const crashP = this.opts.crash?.consume ?? 0;
    for (let n = 0; n < max; n++) {
      const groups = [...this.queues.entries()].filter(([, q]) => q.length);
      if (!groups.length) break;
      const [group, q] = groups[Math.floor(this.rng() * groups.length)]!;
      const msg = q[0]!;
      const r = await consume(this.deps, msg, this.opts.machines ?? DEFAULT_MACHINES);
      this.consumed.push({ inputId: msg.inputId, outcome: r.outcome });
      did = true;
      const planned = this.crashes.findIndex((match) => match(msg));
      if (planned >= 0) this.crashes.splice(planned, 1);
      if (planned >= 0 || (crashP && this.rng() < crashP)) {
        this.counts.add("restart"); // committed, but the message was not acknowledged: redelivered
        continue;
      }
      q.shift();
      if (!q.length) this.queues.delete(group);
    }
    return did;
  }

  /** One round: deliver callbacks, run due intents, consume queue messages. Returns whether anything happened. */
  async step(): Promise<boolean> {
    const a = await this.deliverCallbacks();
    const b = await this.runPendingIntents();
    const c = await this.consumeSome();
    return a || b || c;
  }

  /** The sweep, after moving the clock forward (timers, intent re-drive, scheduler passes). */
  async idle(ms = 60_000): Promise<void> {
    this.clock.advance(ms);
    await runSweep(this.deps);
  }

  /**
   * Run until `done()` holds, or until nothing happens for `maxIdle` sweeps in a row.
   * Returns whether `done()` was reached.
   */
  async runUntil(done: () => Promise<boolean>, o: { maxSteps?: number; maxIdle?: number } = {}): Promise<boolean> {
    const maxSteps = o.maxSteps ?? 2000;
    const maxIdle = o.maxIdle ?? 40;
    let idle = 0;
    for (let s = 0; s < maxSteps; s++) {
      if (await done()) return true;
      this.clock.advance(1000);
      if (await this.step()) {
        idle = 0;
        continue;
      }
      if (++idle > maxIdle) return done();
      await this.idle();
    }
    return done();
  }

  /** Run until the run is complete or cancelled. */
  runToEnd(runId: string, o?: { maxSteps?: number; maxIdle?: number }): Promise<boolean> {
    return this.runUntil(async () => {
      const r = await this.repos.getRun(runId);
      return r?.state === "complete" || r?.state === "cancelled";
    }, o);
  }

  /** The stop switch, through the operator API's own logic (FR-051). */
  async setStopSwitch(on: boolean, reason = "test"): Promise<void> {
    const { setStopSwitch } = await import("@rovara-orch/api");
    await setStopSwitch(this.deps, "dev_op", on, reason);
  }

  /** Nothing in flight: no callbacks or webhooks waiting, no queued messages, no pending intents. */
  async settled(): Promise<boolean> {
    if (this.rovaraPipe.size || this.githubPipe.size || this.queueDepth) return false;
    return (await this.table.queryIndex("PENDING_INTENT", { limit: 1 })).length === 0;
  }

  /** Stop the table stream delivering intents for these effects until `release`. */
  hold(...effects: Intent["effect"][]): void {
    effects.forEach((e) => this.held.add(e));
  }

  release(...effects: Intent["effect"][]): void {
    effects.forEach((e) => this.held.delete(e));
  }

  /** The next time a message matching `match` is consumed, stop after the commit, before the acknowledgement. */
  crashAfterConsuming(match: (m: QueueMessage) => boolean): void {
    this.crashes.push(match);
  }

  /** Pause, resume or cancel a run through the operator API's own logic (FR-050). */
  async controlRun(runId: string, kind: "pause" | "resume" | "cancel", reason = "test", idempotencyKey?: string): Promise<string> {
    const { controlRun } = await import("@rovara-orch/api");
    const r = await controlRun({ deps: this.deps, operator: { id: "dev_op" }, idempotencyKey }, runId, kind, kind, reason);
    return (r.body as { decisionId: string }).decisionId;
  }

  /** Retry, skip or cancel an escalated node through the operator API's own logic (FR-033). */
  async nodeAction(runId: string, nodeId: string, action: "retry" | "skip" | "cancel", reason = "test"): Promise<string> {
    const { nodeAction } = await import("@rovara-orch/api");
    const r = await nodeAction({ deps: this.deps, operator: { id: "dev_op" }, idempotencyKey: undefined }, runId, nodeId, action, reason);
    return (r.body as { decisionId: string }).decisionId;
  }

  faultCounts(): Record<FaultKind, number> {
    return { ...this.counts.counts };
  }
}

export const createHarness = (opts?: HarnessOptions) => Harness.create(opts);
