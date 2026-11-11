import type { GithubClients } from "./app.js";

const split = (repo: string) => {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`not owner/name: ${repo}`);
  return { owner, repo: name };
};
export { split as splitRepo };

/** main's head commit. */
export async function mainHead(gh: GithubClients, repo: string): Promise<string> {
  const r = await gh.rest.repos.getBranch({ ...split(repo), branch: "main" });
  return r.data.commit.sha;
}

/** Whether `sha` is main's head or an ancestor of it (FR-043). */
export async function isReachableFromMain(gh: GithubClients, repo: string, sha: string): Promise<boolean> {
  try {
    const r = await gh.rest.repos.compareCommitsWithBasehead({ ...split(repo), basehead: `${sha}...main` });
    return r.data.status === "ahead" || r.data.status === "identical";
  } catch (e) {
    if ((e as { status?: number }).status === 404) return false;
    throw e;
  }
}

/** Whether the commit exists in the repository and is reachable from some branch (DAG import). */
export async function commitOnRemote(gh: GithubClients, repo: string, sha: string): Promise<boolean> {
  try {
    const r = await gh.rest.repos.listBranchesForHeadCommit({ ...split(repo), commit_sha: sha });
    return r.data.length > 0;
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 404 || status === 422) return false;
    throw e;
  }
}

/** A file's content at a ref, or null when it does not exist. */
export async function readFile(gh: GithubClients, repo: string, path: string, ref: string): Promise<string | null> {
  try {
    const r = await gh.rest.repos.getContent({ ...split(repo), path, ref });
    const d = r.data as { type?: string; content?: string; encoding?: string };
    if (d.type !== "file" || typeof d.content !== "string") return null;
    return Buffer.from(d.content, (d.encoding as BufferEncoding) ?? "base64").toString("utf8");
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
}

/** The combined result of the required checks on a commit (check suites and commit statuses). */
export async function checksForSha(gh: GithubClients, repo: string, sha: string): Promise<{ status: "passed" | "failed" | "pending"; failing: string[] }> {
  const [suites, statuses] = await Promise.all([
    gh.rest.checks.listSuitesForRef({ ...split(repo), ref: sha }),
    gh.rest.repos.getCombinedStatusForRef({ ...split(repo), ref: sha }),
  ]);
  const failing: string[] = [];
  let pending = false;
  for (const s of suites.data.check_suites) {
    if (s.status !== "completed") pending = true;
    else if (s.conclusion && !["success", "neutral", "skipped"].includes(s.conclusion)) failing.push(s.app?.name ?? `suite ${s.id}`);
  }
  for (const s of statuses.data.statuses) {
    if (s.state === "pending") pending = true;
    else if (s.state !== "success") failing.push(s.context);
  }
  return { status: failing.length ? "failed" : pending ? "pending" : "passed", failing };
}
