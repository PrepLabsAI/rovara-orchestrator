import type { GithubClients } from "./app.js";
import { splitRepo } from "./commits.js";

export interface PullInfo {
  number: number;
  url: string;
  headSha: string;
  state: "open" | "closed" | "merged";
  baseRef: string;
  repo: string;
  changedFiles: number;
  mergeCommit: string | null;
  nodeId: string;
}

/** The PR number in Rovara's `pr` URL, until Rovara#438 sends it typed. */
export function prNumberFromUrl(url: string): number | null {
  const m = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)(?:[/?#].*)?$/.exec(url);
  return m ? Number(m[1]) : null;
}

export async function getPull(gh: GithubClients, repo: string, number: number): Promise<PullInfo> {
  const r = await gh.rest.pulls.get({ ...splitRepo(repo), pull_number: number });
  const p = r.data;
  return {
    number: p.number,
    url: p.html_url,
    headSha: p.head.sha,
    state: p.merged ? "merged" : p.state === "open" ? "open" : "closed",
    baseRef: p.base.ref,
    repo: p.base.repo.full_name,
    changedFiles: p.changed_files,
    mergeCommit: p.merged ? p.merge_commit_sha : null,
    nodeId: p.node_id,
  };
}

/** Close a PR; closing a closed or merged PR is a no-op. */
export async function closePull(gh: GithubClients, repo: string, number: number): Promise<void> {
  const p = await getPull(gh, repo, number);
  if (p.state !== "open") return;
  await gh.rest.pulls.update({ ...splitRepo(repo), pull_number: number, state: "closed" });
}
