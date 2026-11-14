/** A typed client for the operator API's GET routes: the only routes the status page uses (FR-053). */

export interface PullRequest { number: number; url: string; state: string }
export interface WaitingFor { reason: string; detail?: string }

export interface RunSummary {
  runId: string;
  dagId: string;
  state: string;
  counts: Record<string, number>;
  costUsd: number;
  startedAt: string;
  actingFor: string;
}

export interface RunNode {
  nodeId: string;
  title: string;
  state: string;
  waitingFor: WaitingFor | null;
  attempt: number | null;
  rovaraTaskUrl: string | null;
  pullRequests: PullRequest[];
}

export interface Notification { key: string; nodeId: string | null; template: string | null; delivered: boolean; tries?: number; lastError: string | null; since?: string }

export interface RunView extends RunSummary {
  repo: string;
  concurrencyLimit: number;
  costLimitUsd: number;
  endedAt: string | null;
  pausedFor: string | null;
  nodes: RunNode[];
  notifications: Notification[];
}

export interface AttemptView {
  attemptId: string;
  n: number;
  phase: string;
  outcome: string | null;
  outcomeReason: string | null;
  rovaraTaskUrl: string | null;
  checkReports: Array<{ status: string; at: string; text: string }>;
  pullRequests: PullRequest[];
  questions: Array<{ eventId: string; question: string; answer: string; answeredBy: string; at: string }>;
  reviewComments: Array<{ threadId: string; path: string | null; line: number | null; body: string; url: string | null; round?: number; resolution?: string | null }>;
}

export interface NodeView {
  runId: string;
  nodeId: string;
  title: string;
  kind: string | null;
  state: string;
  waitingFor: WaitingFor | null;
  attempts: AttemptView[];
  decisions: Array<{ at: string; actor: string; action: string; reason: string }>;
  unblockedBySkip: string[];
}

export interface TraceStep { sequence: number; at: string; kind: string; payload: unknown }
export interface TracePage { steps: TraceStep[]; next: number | null; live: boolean }

export interface StatusApi {
  listRuns(): Promise<RunSummary[]>;
  getRun(runId: string): Promise<RunView>;
  getNode(runId: string, nodeId: string): Promise<NodeView>;
  getTrace(runId: string, nodeId: string, after: number | null): Promise<TracePage>;
}

export class ApiFailed extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ApiFailed";
  }
}

/** The client over HTTP. It sends the operator's sign-in token; it has no write methods. */
export function httpStatusApi(baseUrl: string, token: () => string | null, fetchFn: typeof fetch = fetch): StatusApi {
  const base = baseUrl.replace(/\/$/, "");
  async function get<T>(path: string): Promise<T> {
    const t = token();
    const res = await fetchFn(`${base}${path}`, { method: "GET", headers: t ? { Authorization: `Bearer ${t}` } : {} });
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (!res.ok) throw new ApiFailed(res.status, body?.error?.message ?? res.statusText);
    return body as T;
  }
  const e = encodeURIComponent;
  return {
    listRuns: async () => (await get<{ items: RunSummary[] }>("/v1/runs")).items,
    getRun: (runId) => get(`/v1/runs/${e(runId)}`),
    getNode: (runId, nodeId) => get(`/v1/runs/${e(runId)}/nodes/${e(nodeId)}`),
    getTrace: (runId, nodeId, after) => get(`/v1/runs/${e(runId)}/nodes/${e(nodeId)}/trace?limit=200${after === null ? "" : `&after=${after}`}`),
  };
}
