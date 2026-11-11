import type { Clock } from "@rovara-orch/core";
import type { Access, Operator, OperatorIdentity } from "@rovara-orch/identity";
import type { Repositories, Table } from "@rovara-orch/store";

export interface ApiRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  query: Record<string, string | undefined>;
  body: unknown;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

/** Reads the API needs from GitHub (DAG import checks) and Rovara (sign-in link, admin changes). */
export interface ApiGithub {
  commitOnRemote(repo: string, sha: string): Promise<boolean>;
}

export interface ApiRovara {
  /** Where an operator links their Rovara sign-in to the orchestrator's channel (Rovara FR-030/031). */
  linkUrl(operatorId: string): Promise<string | null>;
  /** Whether the operator has linked their sign-in. */
  isLinked(operatorId: string): Promise<boolean>;
  /** Request a project workspace limit through Rovara's admin change path (Rovara#430). */
  requestWorkspaceLimit?(input: { project: string; openWorkspaces: number; openWorkspacesPerPerson: number; by: string }): Promise<void>;
}

export interface ApiDeps {
  table: Table;
  repos: Repositories;
  identity: OperatorIdentity;
  clock: Clock;
  github: ApiGithub;
  rovara: ApiRovara;
  config: { statusPageUrl: string; maxImportBytes?: number };
  /** Stores an imported DAG file over 300 KB; returns its key. */
  storeLargeSource?(dagId: string, body: string): Promise<string>;
}

export interface RouteContext {
  req: ApiRequest;
  params: Record<string, string>;
  operator: Operator;
  access: Access;
  deps: ApiDeps;
  /** The Idempotency-Key header, if any. */
  idempotencyKey: string | undefined;
}

export interface Route {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Path with `:param` segments, e.g. `/v1/runs/:runId`. */
  pattern: string;
  handler: (ctx: RouteContext) => Promise<ApiResponse>;
}
