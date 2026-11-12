# Quickstart results

Run on 2026-11-11, branch `001-dag-orchestrator`, on a developer machine (macOS, Node 26,
DynamoDB Local in Docker). No stage has been deployed yet, so sections 3 to 5 have not run.

| Section | Status | Result |
|---|---|---|
| 1. Local: unit, property and fault tests | Run, passed | See below |
| 2. Local: import | Run, passed (with one difference, below) | See below |
| 3. TEST stage: a 6-node run | Not run | Needs a TEST deployment, Rovara TEST with the adapter registered, and the test monorepo (docs/runbook.md). Run locally against the fakes instead; see below |
| 4. TEST stage: failure paths | Not run | Needs a TEST deployment. Each path is covered by a fault test against the fakes (below) |
| 5. Load stage | Not run | Needs a load deployment. The load DAG builder is checked locally; the run itself is `npm run load` against the stage |
| CI links | None yet | CI runs on pull requests and on `main`; this branch has no pull request yet, so no CI run exists |

## 1. Local tests

```text
npm test                  63 files, 323 tests passed (unit and property: 10,000 random DAGs for eligibility and file locks)
npm run test:contract      3 files,  16 tests passed (Rovara channel schemas at the pinned commit, GitHub webhooks, main events)
npm run test:integration   3 files,  20 tests passed (DAG import, status API, security)
npm run test:fault         6 files,  22 tests passed
vitest --project infra     5 files,  22 tests passed (CDK assertions)
vitest --project load      1 passed, 1 skipped (the load run needs LOAD=1 and a load stage)
```

The fault suite injects duplicated, delayed, dropped and reordered deliveries and process stops at
every boundary (ingress commit, consumer commit, effect run). Expected results from the quickstart,
and the test that shows each:

| Expected | Shown by |
|---|---|
| No node starts before its dependencies merge; capacity never exceeded | `scheduler/gates/eligibility.test.ts` (10,000 random DAGs) |
| No two running nodes share a file | `scheduler/gates/file-locks.test.ts` (10,000 random cases), `tests/fault/monorepo.test.ts` |
| Exactly one conversation per attempt, one PR per attempt, one merge per node, under faults | `tests/fault/run-happy-path.test.ts` (3 fault seeds) |
| Main red: no start and no merge until green (SC-005) | `tests/fault/monorepo.test.ts` |
| One node failing every time escalates; its dependent waits; an unrelated node merges (SC-006) | `tests/fault/escalation.test.ts` |
| Stop switch holds every start, approval and merge | `tests/fault/run-happy-path.test.ts` |
| Cancel: each task stopped, workspace closed and PR closed once; never merged and cancelled | `tests/fault/cancel.test.ts` |
| Lost Rovara access and the cost limit pause the run; take-over and resume continue it | `tests/fault/operators.test.ts` |
| Workspace-limit refusals use no attempt | `tests/fault/capacity.test.ts` |

## 2. Local import

Against `npm run local` (the operator API on localhost over the fakes and DynamoDB Local), with
the recorded speckit-dag files in `tests/contract/fixtures/speckit-dag/`:

```text
dag import units.json          Imported dag_01M76HJFCS7C4B1P9F91YCDVSX (new).
dag import units.json          Imported dag_01M76HJFCS7C4B1P9F91YCDVSX (already stored; same hash).
dag import dirty-edited.json   refused: spec_dirty
dag import unpushed.json       refused: spec_not_pushed
dag import hash-mismatch.json  refused: hash_mismatch
dag import cycle.json          refused: cycle
```

Difference from the quickstart: "edit one task's text, commit and push, rebuild and import: a new
dag-id" was not run by hand, because the recorded edited file (`edited.json`) is not pushed and is
refused with `spec_not_pushed`. A changed DAG getting a new dag-id is covered by
`tests/integration/dag-import.test.ts`.

The local server cannot see the real `ps06756/speckit-dag` repository, so it treats every commit as
pushed; against a deployment, `commit_not_on_remote` is checked through the GitHub App.

## The 6-node run, locally

Section 3's run, against the fakes instead of Rovara TEST:

```text
rovara-orch run start dag_01M76HJFCS7C4B1P9F91YCDVSX --concurrency 3 --cost-limit 50
run_01M76HJT5HRTXAGZPQ52W6JEX9  complete  acting for dev_op
Nodes: merged 6
  setup, foundational, US1, US2, US3, polish: each one PR, merged, in dependency order
rovara-orch node show … US1    attempt 1 merged; plan approved and merged by the orchestrator, each recorded
```

Found while running it: the CLI printed the API's URL as the status page link. The API now returns
the page links (`pageUrl`), and the CLI prints them.
