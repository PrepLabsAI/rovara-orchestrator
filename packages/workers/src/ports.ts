import type { Clock, ConversationRef, QueueMessage } from "@rovara-orch/core";
import type { Repositories, Table } from "@rovara-orch/store";

/** Ports: the outside systems, as the workers use them. Real clients and test fakes implement these. */

export interface ActorRef {
  channel: string;
  tenant: string;
  userId: string;
}

export interface RovaraApi {
  sendMessage(input: { conversation: ConversationRef; actor: ActorRef; text: string; eventId: string }): Promise<void>;
  sendDecision(input: {
    conversation: ConversationRef;
    actor: ActorRef;
    eventId: string;
    requestId: string;
    expectedRevision: number;
    artifactDigest: string;
    decision: "APPROVE" | "REQUEST_CHANGES" | "REJECT" | "SKIP";
    reason: string;
  }): Promise<void>;
}

export interface PullRequestInfo {
  number: number;
  url: string;
  headSha: string;
  state: "open" | "closed" | "merged";
  baseRef: string;
  repo: string;
  changedFiles: number;
  mergeCommit: string | null;
  nodeId: string;
}

export interface ReviewThreadInfo {
  threadId: string;
  author: string;
  body: string;
  path: string | null;
  line: number | null;
  commit: string | null;
  url: string | null;
  resolved: boolean;
  replies: Array<{ author: string; body: string }>;
}

export interface GithubApi {
  mainHead(repo: string): Promise<string>;
  isReachableFromMain(repo: string, sha: string): Promise<boolean>;
  commitOnRemote(repo: string, sha: string): Promise<boolean>;
  getPull(repo: string, number: number): Promise<PullRequestInfo>;
  listReviewThreads(repo: string, number: number, reviewerLogin: string): Promise<ReviewThreadInfo[]>;
  hasReviewed(repo: string, number: number, headSha: string, reviewerLogin: string): Promise<boolean>;
  resolveThread(threadId: string): Promise<void>;
  comment(repo: string, number: number, body: string): Promise<void>;
  enqueue(repo: string, pullNodeId: string, expectedHeadOid: string): Promise<void>;
  closePull(repo: string, number: number): Promise<void>;
  readFile(repo: string, path: string, ref: string): Promise<string | null>;
  requiredChecksOnMain(repo: string): Promise<{ headSha: string; status: "passed" | "failed" | "pending"; failing: string[] }>;
  /** Required checks on a PR head commit. */
  checksForSha(repo: string, sha: string): Promise<{ status: "passed" | "failed" | "pending"; failing: string[] }>;
}

export interface SlackApi {
  post(input: { channel: string; text: string; key: string }): Promise<{ ts: string }>;
  reply(input: { channel: string; threadTs: string; text: string; key: string }): Promise<{ ts: string }>;
}

export interface AnswerRequest {
  question: string;
  choices: string[];
  specDocs: Array<{ path: string; content: string }>;
  tasks: Array<{ id: string; text: string }>;
  modelId: string;
}
export interface AnswerResult {
  answer: string;
  choice: string | null;
  answeredBy: string;
  tries: number;
  costUsd: number;
  confidence: string | null;
  citations: string[];
}
export interface AnswererApi {
  answer(req: AnswerRequest): Promise<AnswerResult>;
}

export interface WorkQueue {
  /** Send messages; the queue drops a message whose inputId it has seen recently (FIFO deduplication). */
  send(messages: QueueMessage[]): Promise<void>;
}

export interface WorkerConfig {
  rovaraTenant: string;
  rovaraSpace: string;
  /** Rovara channel name the orchestrator is registered as. */
  channel: string;
  statusPageUrl: string;
}

/** What the workers need to know about operators (Rovara-backed once Rovara#442 lands). */
export interface OperatorDirectory {
  isRovaraAdmin(operatorId: string): Promise<boolean>;
}

export interface Deps {
  table: Table;
  repos: Repositories;
  clock: Clock;
  queue: WorkQueue;
  rovara: RovaraApi;
  github: GithubApi;
  slack: SlackApi;
  answerer: AnswererApi;
  config: WorkerConfig;
  operators: OperatorDirectory;
  log?: (entry: Record<string, unknown>) => void;
}
