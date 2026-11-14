import { attemptIdOf, attemptThread, FINAL_ATTEMPT_PHASES } from "@rovara-orch/core";
import { readTrace } from "@rovara-orch/store";
import { ApiError } from "../errors.js";
import type { Route } from "../types.js";

const MAX_LIMIT = 500;

/**
 * GET /v1/runs/{runId}/nodes/{nodeId}/trace?attempt=&after=&limit= (FR-055): steps oldest first;
 * `after` is a sequence; `next` is set when more may follow; `live` is true while the attempt runs.
 */
export const routes: Route[] = [
  {
    method: "GET",
    pattern: "/v1/runs/:runId/nodes/:nodeId/trace",
    handler: async ({ deps, params, req }) => {
      const node = await deps.repos.getRunNode(params.runId!, params.nodeId!);
      if (!node) throw new ApiError("NOT_FOUND", `no node ${params.nodeId} in run ${params.runId}`);
      const n = req.query.attempt ? Number(req.query.attempt) : node.attempts;
      if (!Number.isInteger(n) || n < 1 || n > node.attempts) {
        return { status: 200, body: { steps: [], next: null, live: false } };
      }
      const after = req.query.after ? Number(req.query.after) : null;
      const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit ?? 100) || 100));
      if (after !== null && !Number.isInteger(after)) throw new ApiError("INVALID", "after must be a step sequence", { problem: "after" });
      const attemptId = attemptIdOf(attemptThread(params.runId!, params.nodeId!, n));
      const [{ steps, next }, attempt] = await Promise.all([readTrace(deps.table, attemptId, after, limit), deps.repos.getAttempt(attemptId)]);
      const live = !!attempt && !FINAL_ATTEMPT_PHASES.includes(attempt.phase);
      return { status: 200, body: { steps, next, live } };
    },
  },
];
