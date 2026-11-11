import { notImplemented } from "../errors.js";
import type { Route } from "../types.js";

/** Stub: every route answers 501 until its user story implements it. */
export const routes: Route[] = [
  { method: "POST", pattern: "/v1/dags", handler: async () => { throw notImplemented("POST /v1/dags"); } },
  { method: "GET", pattern: "/v1/dags", handler: async () => { throw notImplemented("GET /v1/dags"); } },
  { method: "GET", pattern: "/v1/dags/:dagId", handler: async () => { throw notImplemented("GET /v1/dags/:dagId"); } },
];
