import { deliver } from "./actor.js";
import type { Executor } from "./types.js";

/** rovara.message: one message in the attempt's conversation. The intent key is Rovara's eventId, so a resend is dropped. */
export const rovaraSend: Executor = (intent, deps) =>
  deliver(deps, intent, ({ attempt, actor, eventId }) => deps.rovara.sendMessage({ conversation: attempt.conversation, actor, text: String(intent.payload.text), eventId }));
