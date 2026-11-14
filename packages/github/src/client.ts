import type { GithubClients } from "./app.js";
import * as commits from "./commits.js";
import { enqueue } from "./merge-queue.js";
import { closePull, getPull } from "./pull-requests.js";
import * as review from "./review.js";

/** The orchestrator's GitHub App, as the workers' GithubApi port. */
export class GithubAppApi {
  constructor(private readonly gh: GithubClients) {}

  mainHead = (repo: string) => commits.mainHead(this.gh, repo);
  isReachableFromMain = (repo: string, sha: string) => commits.isReachableFromMain(this.gh, repo, sha);
  commitOnRemote = (repo: string, sha: string) => commits.commitOnRemote(this.gh, repo, sha);
  readFile = (repo: string, path: string, ref: string) => commits.readFile(this.gh, repo, path, ref);
  checksForSha = (repo: string, sha: string) => commits.checksForSha(this.gh, repo, sha);
  getPull = (repo: string, number: number) => getPull(this.gh, repo, number);
  closePull = (repo: string, number: number) => closePull(this.gh, repo, number);
  listReviewThreads = (repo: string, number: number, reviewer: string) => review.listReviewThreads(this.gh, repo, number, reviewer);
  hasReviewed = (repo: string, number: number, headSha: string, reviewer: string) => review.hasReviewed(this.gh, repo, number, headSha, reviewer);
  resolveThread = (threadId: string) => review.resolveThread(this.gh, threadId);
  comment = (repo: string, number: number, body: string) => review.comment(this.gh, repo, number, body);
  enqueue = (_repo: string, pullNodeId: string, expectedHeadOid: string) => enqueue(this.gh, pullNodeId, expectedHeadOid);

  async requiredChecksOnMain(repo: string) {
    const headSha = await commits.mainHead(this.gh, repo);
    return { headSha, ...(await commits.checksForSha(this.gh, repo, headSha)) };
  }
}
