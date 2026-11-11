# Contract: GitHub App

The orchestrator's own GitHub App, installed on the monorepo only (R7).

## Permissions

| Permission | Level | Why |
|---|---|---|
| Metadata | read | required by GitHub |
| Contents | write | GitHub requires it to merge |
| Pull requests | write | read PRs and review threads, resolve threads, comment for a re-review, close PRs on cancel |
| Checks | read | required checks on PRs and main |
| Commit statuses | read | status-based required checks |

No other permission. The private key lives in the secret store.

## Webhooks received

At `POST /github/events`, verified with the webhook secret (`X-Hub-Signature-256`), repeats dropped
by `X-GitHub-Delivery`.

| Event | Used for |
|---|---|
| `pull_request` | opened, synchronize (new head), closed (merged or not) |
| `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread` | review tool comments and thread resolution (FR-045) |
| `check_suite`, `check_run`, `status` | required checks on PR heads and on main (FR-040, FR-044) |
| `merge_group` | merge queue entries and their check results |
| `push` (main) | merge commits on main (FR-043) and main health |

## Calls made

| Call | When | Idempotency |
|---|---|---|
| GraphQL `enqueuePullRequest(pullRequestId, expectedHeadOid)` | merge conditions hold (FR-040, FR-041) | keyed by PR and head; a repeat for the same head is a no-op |
| GraphQL `reviewThreads` on the PR | after each review event | read only |
| GraphQL `resolveReviewThread(threadId)` | Rovara fixed or answered the thread (FR-045) | resolving a resolved thread is a no-op |
| REST create issue comment (the configured re-review text) | no review within 30 minutes (FR-046) | one per head commit, recorded on the intent |
| REST get commit / compare `main...<sha>` | merged check (FR-043), base commit (FR-014) | read only |
| REST update PR `state: closed` | run cancelled (FR-050) | closing a closed PR is a no-op |

The App never merges a pull request that is not the current attempt's reported PR on the monorepo
targeting main (FR-041). This is checked inside the merge-gate function, not by the caller.

## Repository settings required (D9)

- Merge queue on for `main`; required checks include the CI checks; no required human approval.
- The AI review tool installed and reviewing every PR and every new commit.
- The orchestrator's App allowed to merge through the queue.
