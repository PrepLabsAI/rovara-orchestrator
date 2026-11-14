import type { GithubClients } from "./app.js";

/**
 * Add a PR to the merge queue (FR-041). `expectedHeadOid` is the head Rovara's checks ran on, so a
 * later push cannot be merged unchecked. GitHub treats a repeat for the same head as a no-op.
 */
export async function enqueue(gh: GithubClients, pullNodeId: string, expectedHeadOid: string): Promise<void> {
  await gh.graphql(
    `mutation($id: ID!, $head: GitObjectID!) {
      enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $head }) { mergeQueueEntry { id position } }
    }`,
    { id: pullNodeId, head: expectedHeadOid },
  );
}
