import { attemptAndRun, attemptIdOf } from "./actor.js";
import type { Executor } from "./types.js";

/** rovara.message: one message in the attempt's conversation. The intent key is Rovara's eventId, so a resend is dropped. */
export const rovaraSend: Executor = async (intent, deps) => {
  const { attempt, actor } = await attemptAndRun(deps, attemptIdOf(intent.payload));
  await deps.rovara.sendMessage({ conversation: attempt.conversation, actor, text: String(intent.payload.text), eventId: intent.key });
  return { eventId: intent.key };
};
