import type { QueueMessage } from "@rovara-orch/core";
import type { Executor } from "./types.js";

/** Sends the intent's messages; each carries its own input id as the FIFO deduplication id. */
export const queueEnqueue: Executor = async (intent, deps) => {
  const messages = (intent.payload.messages ?? []) as QueueMessage[];
  await deps.queue.send(messages);
  return { sent: messages.length };
};
