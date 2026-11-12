import { parseAttemptThread } from "@rovara-orch/core";
import { Throttled } from "@rovara-orch/rovara";
import { countOp } from "@rovara-orch/store";
import { deliver } from "./actor.js";
import type { Executor } from "./types.js";

/** rovara.message: one message in the attempt's conversation. The intent key is Rovara's eventId, so a resend is dropped. */
export const rovaraSend: Executor = async (intent, deps) => {
  // The brief is the start request: it and Rovara's throttling refusals of it drive back-off (FR-063).
  const isStart = intent.key.endsWith(".brief");
  const count = async (throttled: boolean) => {
    const runId = parseAttemptThread(String(intent.payload.attemptId).replace(/^att_/, ""))?.runId;
    const run = runId ? await deps.repos.getRun(runId) : undefined;
    if (run) await deps.table.transact([countOp(run.repo, deps.clock.now(), { requests: 1, throttled: throttled ? 1 : 0 })]);
  };
  try {
    const r = await deliver(deps, intent, ({ attempt, actor, eventId }) => deps.rovara.sendMessage({ conversation: attempt.conversation, actor, text: String(intent.payload.text), eventId }));
    if (isStart) await count(false);
    return r;
  } catch (e) {
    if (isStart && e instanceof Throttled) await count(true);
    throw e;
  }
};
