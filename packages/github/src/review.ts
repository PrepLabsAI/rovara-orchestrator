import type { GithubClients } from "./app.js";
import { splitRepo } from "./commits.js";

export interface ReviewThread {
  threadId: string;
  author: string;
  body: string;
  path: string | null;
  line: number | null;
  commit: string | null;
  url: string | null;
  resolved: boolean;
  replies: Array<{ author: string; body: string }>;
}

const THREADS = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          path
          line
          comments(first: 50) {
            nodes { author { login } body url commit { oid } }
          }
        }
      }
    }
  }
}`;

type ThreadsResult = {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          id: string;
          isResolved: boolean;
          path: string | null;
          line: number | null;
          comments: { nodes: Array<{ author: { login: string } | null; body: string; url: string; commit: { oid: string } | null }> };
        }>;
      };
    };
  };
};

/** Review threads started by the review tool (by its login), with the replies after the first comment. */
export async function listReviewThreads(gh: GithubClients, repo: string, number: number, reviewer: string): Promise<ReviewThread[]> {
  const out: ReviewThread[] = [];
  let after: string | null = null;
  do {
    const r: ThreadsResult = await gh.graphql<ThreadsResult>(THREADS, { ...splitRepo(repo), number, after });
    const page = r.repository.pullRequest.reviewThreads;
    for (const t of page.nodes) {
      const [first, ...rest] = t.comments.nodes;
      if (!first || first.author?.login !== reviewer) continue;
      out.push({
        threadId: t.id,
        author: first.author.login,
        body: first.body,
        path: t.path,
        line: t.line,
        commit: first.commit?.oid ?? null,
        url: first.url,
        resolved: t.isResolved,
        replies: rest.map((c) => ({ author: c.author?.login ?? "ghost", body: c.body })),
      });
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return out;
}

/** Whether the review tool submitted a review on this head commit. */
export async function hasReviewed(gh: GithubClients, repo: string, number: number, headSha: string, reviewer: string): Promise<boolean> {
  const r = await gh.rest.pulls.listReviews({ ...splitRepo(repo), pull_number: number, per_page: 100 });
  return r.data.some((rv) => rv.user?.login === reviewer && rv.commit_id === headSha);
}

export async function resolveThread(gh: GithubClients, threadId: string): Promise<void> {
  await gh.graphql(`mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }`, { id: threadId });
}

/** The configured re-review comment (e.g. `@coderabbitai review`). */
export async function comment(gh: GithubClients, repo: string, number: number, body: string): Promise<void> {
  await gh.rest.issues.createComment({ ...splitRepo(repo), issue_number: number, body });
}
