# Contract: Operator API

The HTTPS JSON API that the command line and the status page use. Base path `/v1`. Every request
carries `Authorization: Bearer <token>`, a Rovara sign-in token addressed to the orchestrator
(R9). Every route checks with Rovara that the caller is an operator (FR-054). A refused request is
recorded as a decision with action `refused`.

Errors: `{ "error": { "code": "<UPPER_SNAKE>", "message": "<sentence>" } }` with codes
`AUTH_REQUIRED` (401), `NOT_OPERATOR` (403), `NOT_FOUND` (404), `CONFLICT` (409),
`INVALID` (422), `STOPPED` (423, stop switch on), `UNAVAILABLE` (503).

Write routes take an `Idempotency-Key` header; a repeat with the same key returns the first
result.

## DAGs (US1)

| Method and path | Body | Result |
|---|---|---|
| `POST /v1/dags` | speckit-dag JSON, version 1 | `201 { dagId, hash, created: true }` or `200 { dagId, hash, created: false }` for a known hash (FR-005); `422 INVALID` with `{ problem, path? }` naming the first problem (FR-001 to FR-003) |
| `GET /v1/dags` | | `{ items: [{ dagId, feature, repo, commit, nodeCount, hash, importedAt, importedBy }], next? }` |
| `GET /v1/dags/{dagId}` | | the DAG with its nodes and edges |

`problem` values: `schema`, `version`, `unit`, `hash_mismatch`, `cycle`, `unknown_node`,
`spec_dirty`, `spec_not_pushed`, `commit_not_on_remote`.

## Runs (US2, US5)

| Method and path | Body | Result |
|---|---|---|
| `POST /v1/runs` | `{ dagId, concurrencyLimit, costLimitUsd, retry? }` | `201 { runId }`; `409 CONFLICT` if the DAG has an active run; `422` with `{ problem: "not_linked", linkUrl }` if the operator has not linked their Rovara sign-in to the orchestrator's channel |
| `GET /v1/runs?state=` | | runs with `counts`, `costUsd`, `state` |
| `GET /v1/runs/{runId}` | | run with `counts`, `costUsd`, `actingFor`, and every node's `{ nodeId, title, state, waitingFor, attempt, rovaraTaskUrl, pullRequests[] }` |
| `POST /v1/runs/{runId}/pause` | `{ reason }` | `202 { decisionId }`; applied by the run machine |
| `POST /v1/runs/{runId}/resume` | `{ reason }` | `202 { decisionId }`; applied by the run machine |
| `POST /v1/runs/{runId}/cancel` | `{ reason }` | `202 { decisionId }`; the run machine creates cancel, close and PR-close intents for its attempts (FR-050) |
| `POST /v1/runs/{runId}/take-over` | `{ reason }` | `202 { decisionId }`; `actingFor` becomes the caller once applied (FR-057) |

Each of these writes the decision record and the run machine's input in one transaction, so a
retry with the same `Idempotency-Key` never loses or doubles the action.

## Nodes (US3, US5)

| Method and path | Body | Result |
|---|---|---|
| `GET /v1/runs/{runId}/nodes/{nodeId}` | | node state, every attempt with phases, check reports, questions and answers, review comments, pull requests, and decision records |
| `GET /v1/runs/{runId}/nodes/{nodeId}/trace?attempt=&after=&limit=` | | `{ steps: [{ sequence, at, kind, payload }], next, live }`, oldest first; `after` is a sequence; `live` is true while the attempt runs (FR-055) |
| `POST /v1/runs/{runId}/nodes/{nodeId}/retry` | `{ reason }` | `200`; only from `escalated` |
| `POST /v1/runs/{runId}/nodes/{nodeId}/skip` | `{ reason }` | `200`; only from `escalated`; shown as skipped, never merged |
| `POST /v1/runs/{runId}/nodes/{nodeId}/cancel` | `{ reason }` | `200` |

## Global (US5, US6)

| Method and path | Body | Result |
|---|---|---|
| `GET /v1/stop-switch` | | `{ on, by, at, reason }` |
| `PUT /v1/stop-switch` | `{ on, reason }` | `200` (FR-051) |
| `GET /v1/repos/{owner}/{name}` | | `{ paused, pausedSince, mainCommit, startRate, rovaraFreeWorkspaces }` |
| `POST /v1/repos/{owner}/{name}/workspace-limit` | `{ openWorkspaces, openWorkspacesPerPerson }` | `202` when requested through Rovara's admin change path; `403 NOT_OPERATOR` with `problem: "not_rovara_admin"` otherwise (FR-061) |

## Status page

The status page uses only the `GET` routes above. It offers no actions (FR-053) and signs in the
same way (FR-056).
