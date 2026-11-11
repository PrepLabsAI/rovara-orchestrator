import { notImplemented } from "../errors.js";
import type { Route } from "../types.js";

/** Stub: every route answers 501 until its user story implements it. */
export const routes: Route[] = [
  { method: "POST", pattern: "/v1/runs/:runId/nodes/:nodeId/retry", handler: async () => { throw notImplemented("POST /v1/runs/:runId/nodes/:nodeId/retry"); } },
  { method: "POST", pattern: "/v1/runs/:runId/nodes/:nodeId/skip", handler: async () => { throw notImplemented("POST /v1/runs/:runId/nodes/:nodeId/skip"); } },
  { method: "POST", pattern: "/v1/runs/:runId/nodes/:nodeId/cancel", handler: async () => { throw notImplemented("POST /v1/runs/:runId/nodes/:nodeId/cancel"); } },
];
