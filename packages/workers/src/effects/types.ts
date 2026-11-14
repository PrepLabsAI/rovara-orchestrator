import type { Intent } from "@rovara-orch/core";
import type { Deps } from "../ports.js";

/** Carries out one intent. Must be idempotent by the intent's key: running it twice has one effect. */
export type Executor = (intent: Intent, deps: Deps) => Promise<Record<string, unknown>>;

export class NotImplemented extends Error {
  constructor(effect: string) {
    super(`no executor for ${effect} yet`);
    this.name = "NotImplemented";
  }
}

export const notImplemented =
  (effect: string): Executor =>
  async () => {
    throw new NotImplemented(effect);
  };
