import { enqueueMany, type QueueMessage, type WorkMessage } from "@rovara-orch/core";
import { verifyGithubSignature } from "@rovara-orch/github";
import { ConditionFailed, intentOps, keys, type Op } from "@rovara-orch/store";
import { checks } from "./github-events/checks.js";
import { mainChecks } from "./github-events/main-checks.js";
import { mainPush } from "./github-events/main-push.js";
import { mergeGroup } from "./github-events/merge-group.js";
import { pullRequests } from "./github-events/pull-requests.js";
import { reviews } from "./github-events/reviews.js";
import type { GithubEventHandler } from "./github-events/types.js";
import type { HttpRequest, HttpResponse } from "./ingress-rovara.js";
import type { Deps } from "./ports.js";

const CHECK_EVENTS = new Set(["check_suite", "check_run", "status"]);

/** Is this check event about the head of the default branch (main) rather than a PR head? */
function isOnMain(event: string, payload: Record<string, unknown>): boolean {
  const branch =
    event === "check_suite"
      ? (payload.check_suite as { head_branch?: string } | undefined)?.head_branch
      : event === "check_run"
        ? (payload.check_run as { check_suite?: { head_branch?: string } } | undefined)?.check_suite?.head_branch
        : ((payload.branches as Array<{ name: string }> | undefined) ?? []).some((b) => b.name === "main")
          ? "main"
          : undefined;
  return branch === "main";
}

export function route(event: string, payload: Record<string, unknown>): GithubEventHandler | undefined {
  if (event === "pull_request") return pullRequests;
  if (event === "pull_request_review" || event === "pull_request_review_comment" || event === "pull_request_review_thread") return reviews;
  if (CHECK_EVENTS.has(event)) return isOnMain(event, payload) ? mainChecks : checks;
  if (event === "merge_group") return mergeGroup;
  if (event === "push") return mainPush;
  return undefined;
}

/**
 * POST /github/events. Verify, map the event to inputs, then in ONE transaction write the delivery's
 * repeat marker and an enqueue intent for the inputs; answer 2xx only after it commits.
 */
export async function handleGithubEvent(
  deps: Deps,
  secret: string,
  req: HttpRequest,
  router: (event: string, payload: Record<string, unknown>) => GithubEventHandler | undefined = route,
): Promise<HttpResponse> {
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (!verifyGithubSignature(secret, req.body, headers["x-hub-signature-256"])) return { status: 401, body: "bad signature" };
  const deliveryId = headers["x-github-delivery"];
  const event = headers["x-github-event"];
  if (!deliveryId || !event) return { status: 400, body: "missing delivery or event header" };
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(req.body);
  } catch {
    return { status: 400, body: "body is not JSON" };
  }
  const marker = keys.delivery(deliveryId);
  if (await deps.table.get(marker)) return { status: 200, body: "duplicate" };
  const handler = router(event, payload);
  const inputs: WorkMessage[] = handler ? await handler(deps, payload, deliveryId) : [];
  const now = deps.clock.now().toISOString();
  const ops: Op[] = [{ kind: "put", item: { ...marker, entityType: "GHDELIVERY", event, at: now }, ifNotExists: true }];
  if (inputs.length) {
    const messages: QueueMessage[] = inputs.map((m, i) => ({ ...m, inputId: `gh:${deliveryId}:${i}` }) as QueueMessage);
    ops.push(...intentOps(marker.pk, [enqueueMany(messages, `gh:${deliveryId}`)], now).ops);
  }
  try {
    await deps.table.transact(ops);
  } catch (e) {
    if (e instanceof ConditionFailed) return { status: 200, body: "duplicate" };
    throw e;
  }
  return { status: 200, body: inputs.length ? "ok" : "ignored" };
}
