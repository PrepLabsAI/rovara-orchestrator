import { repoOf } from "./lookups.js";
import type { GithubEventHandler } from "./types.js";

/** push: a new head on main goes to the repository machine (FR-044). Other branches are ignored. */
export const mainPush: GithubEventHandler = async (_deps, payload) => {
  if (payload.ref !== "refs/heads/main" || typeof payload.after !== "string") return [];
  return [{ group: `repo:${repoOf(payload)}`, input: { kind: "main_push", headSha: payload.after } }];
};
