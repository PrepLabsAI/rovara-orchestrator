import type { ChannelEvent } from "@rovara-orch/rovara";
import type { Op } from "@rovara-orch/store";

/** Extra writes for a stored Rovara event, made in the ingress's transaction (e.g. trace steps, US5). */
export type RovaraEventHook = (event: ChannelEvent, attemptId: string, receivedAt: string) => Op[];

export const ROVARA_EVENT_HOOKS: RovaraEventHook[] = [];
