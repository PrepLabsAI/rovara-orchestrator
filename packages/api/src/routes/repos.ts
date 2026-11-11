import { notImplemented } from "../errors.js";
import type { Route } from "../types.js";

/** Stub: every route answers 501 until its user story implements it. */
export const routes: Route[] = [
  { method: "GET", pattern: "/v1/repos/:owner/:name", handler: async () => { throw notImplemented("GET /v1/repos/:owner/:name"); } },
  { method: "POST", pattern: "/v1/repos/:owner/:name/workspace-limit", handler: async () => { throw notImplemented("POST /v1/repos/:owner/:name/workspace-limit"); } },
];
