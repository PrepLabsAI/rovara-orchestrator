import { randomUUID } from "node:crypto";
import { parseAttemptThread } from "@rovara-orch/core";
import { ChannelDecisionSchema, InboundMessageSchema, type ConversationRef } from "@rovara-orch/rovara";
import type { ActorRef, RovaraApi } from "@rovara-orch/workers";
import type { FakeGithub } from "./fake-github.js";

/** How a node's Rovara conversations behave. One behaviour per node id; attempts share it. */
export interface Behaviour {
  /** Files the agent's PR touches. */
  files?: string[];
  /** Check report statuses, consumed one per coding round; then `passed`. */
  checks?: Array<"passed" | "failed" | "unknown">;
  /** Questions asked after the plan is approved, one at a time. */
  questions?: Array<{ text: string; choices?: string[] }>;
  /** Fail this many first attempts with a workspace error. */
  failStarts?: number;
  /** Refuse this many first starts with Rovara's workspace limit. */
  workspaceLimits?: number;
  /** Ask for an administrator's confirmation instead of a plan approval. */
  askAdmin?: boolean;
  /** Approval requests arrive without actions (the adapter is registered with step-up). */
  steppedUp?: boolean;
  /** Never answer at all (quiet-timeout tests). */
  silent?: boolean;
}

interface Conversation {
  ref: ConversationRef;
  nodeId: string;
  behaviour: Behaviour;
  stage: "new" | "awaiting_decision" | "awaiting_answer" | "coding" | "checked" | "pr_open" | "closed" | "cancelled";
  checkRound: number;
  questionIdx: number;
  pr: number | null;
  received: Array<{ kind: "message" | "decision"; text: string }>;
}

export interface OutgoingEvent {
  id: string;
  body: Record<string, unknown>;
}

const isFix = (t: string) => /fail/i.test(t) && /fix/i.test(t);
const isReview = (t: string) => /review comment/i.test(t);
const isUpdate = (t: string) => /update the pull request from main/i.test(t);
const isCreatePr = (t: string) => /create the pull request/i.test(t);
const isClose = (t: string) => t.trim().toLowerCase() === "close this workspace";
const isStop = (t: string) => t.trim().toLowerCase() === "stop";

/** In-memory Rovara channel API: accepts signed-schema requests, replays scripted conversations. */
export class FakeRovara implements RovaraApi {
  readonly conversations = new Map<string, Conversation>();
  readonly seenEventIds = new Set<string>();
  readonly duplicateRequests: string[] = [];
  private startsByNode = new Map<string, number>();
  private sink: (e: OutgoingEvent) => void = () => {};
  private eventCounter = 0;

  constructor(
    private readonly github: FakeGithub,
    private readonly behaviours: Record<string, Behaviour> = {},
  ) {}

  onEvent(sink: (e: OutgoingEvent) => void): void {
    this.sink = sink;
  }

  setBehaviour(nodeId: string, b: Behaviour): void {
    this.behaviours[nodeId] = b;
  }

  /** Conversations (attempts) started for a node. */
  attemptsFor(nodeId: string): Conversation[] {
    return [...this.conversations.values()].filter((c) => c.nodeId === nodeId);
  }

  private emit(c: Conversation, type: string, data: Record<string, unknown>): void {
    const id = `evt_${(++this.eventCounter).toString(36).padStart(8, "0")}${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    this.sink({ id, body: { version: 1, id, channel: c.ref.channel, conversation: c.ref, createdAt: new Date().toISOString(), type, data } });
  }

  private conv(ref: ConversationRef): Conversation {
    let c = this.conversations.get(ref.thread);
    if (!c) {
      const nodeId = parseAttemptThread(ref.thread)?.nodeId ?? "unknown";
      c = { ref, nodeId, behaviour: this.behaviours[nodeId] ?? {}, stage: "new", checkRound: 0, questionIdx: 0, pr: null, received: [] };
      this.conversations.set(ref.thread, c);
    }
    return c;
  }

  async sendMessage(input: { conversation: ConversationRef; actor: ActorRef; text: string; eventId: string }): Promise<void> {
    InboundMessageSchema.parse({ version: 2, channel: input.conversation.channel, eventId: input.eventId, conversation: input.conversation, actor: input.actor, text: input.text, receivedAt: new Date().toISOString() });
    if (this.seenEventIds.has(input.eventId)) {
      this.duplicateRequests.push(input.eventId);
      return;
    }
    this.seenEventIds.add(input.eventId);
    const c = this.conv(input.conversation);
    c.received.push({ kind: "message", text: input.text });
    if (c.behaviour.silent || c.stage === "closed" || c.stage === "cancelled") return;
    const t = input.text;

    if (isStop(t)) {
      c.stage = "cancelled";
      this.emit(c, "done", { text: "Stopped." });
      return;
    }
    if (isClose(t)) {
      c.stage = "closed";
      this.emit(c, "message", { text: "Workspace closed." });
      return;
    }
    if (c.stage === "new") return this.onBrief(c);
    if (c.stage === "awaiting_answer") {
      c.questionIdx++;
      return this.afterApproval(c);
    }
    if (isCreatePr(t) && c.pr === null) {
      const files = c.behaviour.files ?? [`src/${c.nodeId.toLowerCase()}.ts`];
      const { number, url } = this.github.openPull({ headRef: `rovara/${c.ref.thread}`, title: `${c.nodeId}`, files });
      c.pr = number;
      c.stage = "pr_open";
      this.emit(c, "pr", { url, title: `${c.nodeId}` });
      return;
    }
    if (isReview(t) && c.pr !== null) {
      this.emit(c, "progress", { text: "Addressing the review comments." });
      this.github.pushToPull(c.pr, { fixesThreads: true });
      return;
    }
    if (isUpdate(t) && c.pr !== null) {
      this.emit(c, "progress", { text: "Updating from main." });
      this.github.pushToPull(c.pr, { fromMain: true });
      return;
    }
    if (isFix(t)) return this.code(c);
  }

  async sendDecision(input: {
    conversation: ConversationRef;
    actor: ActorRef;
    eventId: string;
    requestId: string;
    expectedRevision: number;
    artifactDigest: string;
    decision: "APPROVE" | "REQUEST_CHANGES" | "REJECT" | "SKIP";
    reason: string;
  }): Promise<void> {
    ChannelDecisionSchema.parse({ version: 1, channel: input.conversation.channel, ...input, receivedAt: new Date().toISOString() });
    if (this.seenEventIds.has(input.eventId)) {
      this.duplicateRequests.push(input.eventId);
      return;
    }
    this.seenEventIds.add(input.eventId);
    const c = this.conv(input.conversation);
    c.received.push({ kind: "decision", text: input.decision });
    if (c.stage !== "awaiting_decision" || input.decision !== "APPROVE") return;
    this.afterApproval(c);
  }

  private onBrief(c: Conversation): void {
    this.emit(c, "ack", { inReplyTo: "brief" });
    const starts = (this.startsByNode.get(c.nodeId) ?? 0) + 1;
    this.startsByNode.set(c.nodeId, starts);
    if (starts <= (c.behaviour.workspaceLimits ?? 0)) {
      c.stage = "closed";
      this.emit(c, "error", { code: "workspace_limit", text: "The workspace limit is reached." });
      return;
    }
    if (starts - (c.behaviour.workspaceLimits ?? 0) <= (c.behaviour.failStarts ?? 0)) {
      c.stage = "closed";
      this.emit(c, "error", { code: "workspace_failed", text: "The workspace could not start." });
      return;
    }
    c.stage = "awaiting_decision";
    this.emit(c, "approval_request", {
      text: c.behaviour.askAdmin ? "This needs an administrator's confirmation." : "Here is the plan.",
      kind: c.behaviour.askAdmin ? "admin" : "plan_approval",
      requestId: randomUUID(),
      expectedRevision: 1,
      artifactDigest: "a".repeat(64),
      taskUrl: `https://rovara.test/tasks/${encodeURIComponent(c.ref.thread)}`,
      ...(c.behaviour.steppedUp ? {} : { actions: [{ decision: "APPROVE", label: "Approve" }] }),
    });
  }

  private afterApproval(c: Conversation): void {
    const q = c.behaviour.questions?.[c.questionIdx];
    if (q) {
      c.stage = "awaiting_answer";
      this.emit(c, "question", { text: q.text, ...(q.choices ? { choices: q.choices } : {}) });
      return;
    }
    this.code(c);
  }

  private code(c: Conversation): void {
    c.stage = "coding";
    this.emit(c, "progress", { text: "Writing the code." });
    const status = c.behaviour.checks?.[c.checkRound] ?? "passed";
    c.checkRound++;
    c.stage = "checked";
    this.emit(c, "check_report", { text: `Checks ${status}.`, status });
  }
}
