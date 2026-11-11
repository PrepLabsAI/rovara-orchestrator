import { notImplemented } from "../errors.js";
import type { Route } from "../types.js";

/** Stub: every route answers 501 until its user story implements it. */
export const routes: Route[] = [
  { method: "GET", pattern: "/v1/stop-switch", handler: async () => { throw notImplemented("GET /v1/stop-switch"); } },
  { method: "PUT", pattern: "/v1/stop-switch", handler: async () => { throw notImplemented("PUT /v1/stop-switch"); } },
];
