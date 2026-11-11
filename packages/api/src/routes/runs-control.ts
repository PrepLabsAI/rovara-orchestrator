import { notImplemented } from "../errors.js";
import type { Route } from "../types.js";

/** Stub: every route answers 501 until its user story implements it. */
export const routes: Route[] = [
  { method: "POST", pattern: "/v1/runs/:runId/pause", handler: async () => { throw notImplemented("POST /v1/runs/:runId/pause"); } },
  { method: "POST", pattern: "/v1/runs/:runId/resume", handler: async () => { throw notImplemented("POST /v1/runs/:runId/resume"); } },
  { method: "POST", pattern: "/v1/runs/:runId/cancel", handler: async () => { throw notImplemented("POST /v1/runs/:runId/cancel"); } },
  { method: "POST", pattern: "/v1/runs/:runId/take-over", handler: async () => { throw notImplemented("POST /v1/runs/:runId/take-over"); } },
];
