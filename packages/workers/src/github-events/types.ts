import type { WorkMessage } from "@rovara-orch/core";
import type { Deps } from "../ports.js";

/** Maps one GitHub webhook payload to the attempt or repository inputs it produces. May read, never write. */
export type GithubEventHandler = (deps: Deps, payload: Record<string, unknown>, deliveryId: string) => Promise<WorkMessage[]>;

export const ignore: GithubEventHandler = async () => [];
