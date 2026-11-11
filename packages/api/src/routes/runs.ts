import { notImplemented } from "../errors.js";
import type { Route } from "../types.js";

/** Stub: every route answers 501 until its user story implements it. */
export const routes: Route[] = [
  { method: "POST", pattern: "/v1/runs", handler: async () => { throw notImplemented("POST /v1/runs"); } },
  { method: "GET", pattern: "/v1/runs", handler: async () => { throw notImplemented("GET /v1/runs"); } },
  { method: "GET", pattern: "/v1/runs/:runId", handler: async () => { throw notImplemented("GET /v1/runs/:runId"); } },
];
