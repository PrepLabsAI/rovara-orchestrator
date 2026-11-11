import { AuthRequired, type Access, type Operator } from "@rovara-orch/identity";
import { decisionOps } from "@rovara-orch/store";
import { ApiError } from "./errors.js";
import type { ApiDeps, ApiRequest } from "./types.js";

function bearer(req: ApiRequest): string | undefined {
  const h = req.headers.authorization ?? req.headers.Authorization;
  const m = h ? /^Bearer\s+(.+)$/i.exec(h) : null;
  return m?.[1];
}

/** Record a refused request as a decision (FR-054), with no run. */
async function recordRefusal(deps: ApiDeps, req: ApiRequest, actor: string, reason: string): Promise<void> {
  const now = deps.clock.now().toISOString();
  await deps.table
    .transact(decisionOps(null, [{ actor, action: "refused", reason, detail: { method: req.method, path: req.path } }], now))
    .catch(() => undefined);
}

/** Verify the token and ask, on every request, whether the person is still an operator. */
export async function authenticate(deps: ApiDeps, req: ApiRequest): Promise<{ operator: Operator; access: Access }> {
  let operator: Operator;
  try {
    operator = await deps.identity.verify(bearer(req));
  } catch (e) {
    if (e instanceof AuthRequired) {
      await recordRefusal(deps, req, "anonymous", e.message);
      throw new ApiError("AUTH_REQUIRED", e.message);
    }
    throw e;
  }
  const access = await deps.identity.access(operator);
  if (!access.isOperator) {
    await recordRefusal(deps, req, operator.id, "not an operator");
    throw new ApiError("NOT_OPERATOR", `${operator.name} is not a Rovara administrator and has no access to the monorepo's project`);
  }
  return { operator, access };
}
