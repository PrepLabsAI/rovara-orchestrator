import { attemptAndRun, attemptIdOf } from "./actor.js";
import type { Executor } from "./types.js";

/** Rovara's documented stop phrase. Typed cancel replaces it once PrepLabsAI/Rovara#439 lands. */
export const STOP_TEXT = "stop";

/** rovara.cancel: stop the attempt's running task (FR-050). The reply is never read. */
export const rovaraCancel: Executor = async (intent, deps) => {
  const { attempt, actor } = await attemptAndRun(deps, attemptIdOf(intent.payload));
  await deps.rovara.sendMessage({ conversation: attempt.conversation, actor, text: STOP_TEXT, eventId: intent.key });
  return { requested: "stop" };
};
