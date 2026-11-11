import type { IntentSpec, NodeRunState, NodeState } from "../model.js";
import type { Counters, WorkMessage } from "./types.js";

/** Move a node to a new state, returning the updated node and the count change for the Run. */
export function moveNode(
  node: NodeRunState,
  to: NodeState,
  patch: Partial<NodeRunState> = {},
): { node: NodeRunState; counters: Counters } {
  const next: NodeRunState = { ...node, ...patch, state: to };
  if (node.state === to) return { node: next, counters: {} };
  return { node: next, counters: { counts: { [node.state]: -1, [to]: 1 } } };
}

export function mergeCounters(...all: Array<Counters | undefined>): Counters {
  const out: Counters = {};
  for (const c of all) {
    if (!c) continue;
    if (c.costUsd) out.costUsd = (out.costUsd ?? 0) + c.costUsd;
    for (const [k, v] of Object.entries(c.counts ?? {})) {
      out.counts ??= {};
      const key = k as NodeState;
      out.counts[key] = (out.counts[key] ?? 0) + (v ?? 0);
    }
  }
  return out;
}

/** A queue message with the id that makes processing it idempotent (its input marker). */
export type QueueMessage = WorkMessage & { inputId: string };

/** An enqueue intent: the only way a machine asks for another input to be processed. */
export function enqueue(message: WorkMessage, key: string): IntentSpec {
  return { effect: "queue.enqueue", key, payload: { messages: [{ ...message, inputId: key }] } };
}

/**
 * One enqueue intent carrying many messages (a run cancel fanning out to every attempt), so a
 * transaction stays under DynamoDB's 100-write limit. Each message has its own stable input id.
 */
export function enqueueMany(messages: QueueMessage[], key: string): IntentSpec {
  return { effect: "queue.enqueue", key, payload: { messages } };
}
