import { authenticate } from "./auth.js";
import { ApiError } from "./errors.js";
import { routes as dags } from "./routes/dags.js";
import { routes as me } from "./routes/me.js";
import { routes as nodesActions } from "./routes/nodes-actions.js";
import { routes as nodesRead } from "./routes/nodes-read.js";
import { routes as repos } from "./routes/repos.js";
import { routes as runsControl } from "./routes/runs-control.js";
import { routes as runs } from "./routes/runs.js";
import { routes as stopSwitch } from "./routes/stop-switch.js";
import { routes as trace } from "./routes/trace.js";
import type { ApiDeps, ApiRequest, ApiResponse, Route } from "./types.js";

export const ROUTES: Route[] = [...me, ...dags, ...runs, ...runsControl, ...nodesRead, ...nodesActions, ...trace, ...stopSwitch, ...repos];

/** Match `/v1/runs/:runId` against a path; returns the params, or undefined. */
export function match(pattern: string, path: string): Record<string, string> | undefined {
  const p = pattern.split("/").filter(Boolean);
  const s = path.split("?")[0]!.split("/").filter(Boolean);
  if (p.length !== s.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i]!.startsWith(":")) params[p[i]!.slice(1)] = decodeURIComponent(s[i]!);
    else if (p[i] !== s[i]) return undefined;
  }
  return params;
}

/**
 * Handle one operator API request: find the route, authenticate (every route; refusals recorded),
 * then run the handler. Errors become `{ error: { code, message } }`.
 */
export async function handle(deps: ApiDeps, req: ApiRequest, routes: Route[] = ROUTES): Promise<ApiResponse> {
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const request = { ...req, headers };
  try {
    let found: { route: Route; params: Record<string, string> } | undefined;
    let pathMatched = false;
    for (const route of routes) {
      const params = match(route.pattern, request.path);
      if (!params) continue;
      pathMatched = true;
      if (route.method === request.method.toUpperCase()) {
        found = { route, params };
        break;
      }
    }
    if (!found) throw new ApiError("NOT_FOUND", pathMatched ? `${request.method} is not allowed here` : `no route for ${request.path}`);
    const { operator, access } = await authenticate(deps, request);
    return await found.route.handler({ req: request, params: found.params, operator, access, deps, idempotencyKey: headers["idempotency-key"] });
  } catch (e) {
    if (e instanceof ApiError) return { status: e.status, body: e.toBody() };
    throw e;
  }
}
