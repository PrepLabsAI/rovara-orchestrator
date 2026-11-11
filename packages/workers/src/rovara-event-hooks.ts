import type { ChannelEvent } from "@rovara-orch/rovara";
import type { Op } from "@rovara-orch/store";
import { traceHook } from "./hooks/trace.js";
import type { Deps } from "./ports.js";

/** Extra writes for a stored Rovara event, made in the ingress's transaction (e.g. trace steps). May read, never write. */
export type RovaraEventHook = (deps: Deps, event: ChannelEvent, attemptId: string, receivedAt: string) => Promise<Op[]>;

export const ROVARA_EVENT_HOOKS: RovaraEventHook[] = [traceHook];
