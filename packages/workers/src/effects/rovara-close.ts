import { attemptAndRun, attemptIdOf } from "./actor.js";
import type { Executor } from "./types.js";

/** Rovara's documented close phrase. Typed close replaces it once PrepLabsAI/Rovara#439 lands. */
export const CLOSE_TEXT = "close this workspace";

/** rovara.close: ask Rovara to close the attempt's workspace (FR-026). The reply is never read. */
export const rovaraClose: Executor = async (intent, deps) => {
  const { attempt, actor } = await attemptAndRun(deps, attemptIdOf(intent.payload));
  await deps.rovara.sendMessage({ conversation: attempt.conversation, actor, text: CLOSE_TEXT, eventId: intent.key });
  return { requested: "close" };
};
