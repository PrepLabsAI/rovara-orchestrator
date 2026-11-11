import type { Graph } from "./schema.js";

export interface RemoteCheck {
  /** Whether the commit exists in the repository and is reachable from a branch on the remote. */
  commitOnRemote(repo: string, sha: string): Promise<boolean>;
}

/** `git@github.com:o/r.git`, `https://github.com/o/r(.git)` or `o/r` → `o/r`. */
export function normalizeRepo(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const m =
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(remote) ??
    /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote) ??
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(remote);
  return m ? `${m[1]}/${m[2]}` : null;
}

export type SourceProblem = "spec_dirty" | "spec_not_pushed" | "commit_not_on_remote";

/** Refuse specs Rovara's workspaces could not see: uncommitted, unpushed, or not on the remote. */
export async function checkSource(graph: Graph, github: RemoteCheck): Promise<{ problem: SourceProblem; message: string } | { repo: string }> {
  if (graph.spec.dirty) return { problem: "spec_dirty", message: "the spec folder has uncommitted changes; commit and push them first" };
  if (!graph.spec.pushed) return { problem: "spec_not_pushed", message: "the spec's commit is not pushed; Rovara's workspaces clone from the remote" };
  const repo = normalizeRepo(graph.spec.repo);
  if (!repo || !graph.spec.commit) return { problem: "commit_not_on_remote", message: "the graph does not name its repository and commit" };
  if (!(await github.commitOnRemote(repo, graph.spec.commit))) {
    return { problem: "commit_not_on_remote", message: `commit ${graph.spec.commit} is not on a branch of ${repo}` };
  }
  return { repo };
}
