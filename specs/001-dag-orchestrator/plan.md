# Implementation Plan: DAG Orchestrator for Rovara

**Branch**: `001-dag-orchestrator` | **Date**: 2026-11-11 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-dag-orchestrator/spec.md`

## Summary

Build a service that takes a DAG produced by `speckit-dag --unit story`, stores it under a dag-id,
and runs it on one monorepo: it starts each unblocked node as one Rovara conversation through
Rovara's channel adapter API, approves the plan, answers the agent's questions with Claude Opus 5.5,
gets the pull request opened, has every AI review comment addressed, merges through GitHub's merge
queue with its own GitHub App, closes the workspace and unblocks the next nodes. Operators use a
command line and a read-only status page with a live agent trace, and sign in with Rovara.

Technically it is a TypeScript, event-driven AWS service (API Gateway, Lambda, SQS FIFO, DynamoDB),
whose core is a set of pure state machines and a pure scheduler. Every outside effect is written as
an intent in the same transaction as the state change that needs it, then carried out idempotently,
so restarts and repeated events cause no duplicates ([research.md](research.md) R2, R3).

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22.19+ (R1)

**Primary Dependencies**: zod (contracts); AWS SDK v3 and AWS CDK v2 (infrastructure);
`@anthropic-ai/sdk` and `@anthropic-ai/bedrock-sdk` (answering model, R8); Octokit with GraphQL
(GitHub, R7); `@slack/web-api` (notifications); `standardwebhooks` (Rovara signatures); React +
Vite (status page); commander (CLI)

**Storage**: DynamoDB, one table, on-demand, point-in-time recovery, TTL for trace steps; S3 for
oversized imported DAG files (R3, [data-model.md](data-model.md))

**Testing**: Vitest and fast-check; fakes of Rovara, GitHub, Slack and the model in
`packages/testkit`; DynamoDB Local for the fault suite; recorded GitHub payloads; Rovara contract
test at a pinned commit (R11)

**Target Platform**: AWS Lambda (Node.js 22, arm64) in the same account and region as the Rovara
install; status page on S3 + CloudFront; CLI on macOS and Linux

**Project Type**: web service + CLI + static web app, in one npm-workspaces repository

**Performance Goals**: 1000 concurrent nodes in one run (SC-007); 95% of eligible nodes started
within 60 s when capacity is free (SC-003); 95% of trace steps on the status page within 10 s
(SC-009)

**Constraints**: exactly-once outside effects across restarts (Principle III, SC-004); no person on
the normal path (Principle VI); talk to Rovara only through its published interfaces (Principle
IV); trace steps at most 64 KB each (Rovara's cap)

**Scale/Scope**: DAGs of up to a few thousand nodes; several concurrent runs per monorepo; trace
volume up to ~200 steps/s at full concurrency; a handful of operators

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

Constitution v1.0.0 ([.specify/memory/constitution.md](../../.specify/memory/constitution.md)).

| Principle | Gate | Pre-design | Post-design |
|---|---|---|---|
| I. Thin Orchestrator | No planning, coding or DAG building in scope | Pass: spec Overview | Pass: no component writes product code or edits DAGs; the answering model only answers questions Rovara asks |
| II. Immutable DAGs | Import refuses dirty or unpushed specs; dag-id from hash; no edit path | Pass: FR-002 to FR-005 | Pass: hash-identity item written with `attribute_not_exists`; no update route for DAGs ([operator-api.md](contracts/operator-api.md)) |
| III. Exactly-Once Effects | Decision stored before acting; idempotent effects; unknown state read, not guessed | Pass: FR-060, FR-034 | Pass: intent pattern (R3); every effect has an idempotency key ([data-model.md](data-model.md) Intent); quiet nodes escalate until Rovara#437 |
| IV. Rovara Through Its Contracts | Only published interfaces; named operator; gaps filed upstream | Pass: FR-020, FR-057, D2 to D11 filed | Pass: [rovara-channel.md](contracts/rovara-channel.md) uses only the channel API, sign-in and admin settings; pinned schemas with a contract test (R4); interim close and cancel send Rovara's documented phrases and never read reply text |
| V. Gated Merges | Own App, merge queue, all four gates, stop-the-line | Pass: FR-040 to FR-046 | Pass: one merge-gate function; `enqueuePullRequest` with `expectedHeadOid` (R7); repository pause item ([data-model.md](data-model.md) Repository) |
| VI. Unattended but Attributable | No person on normal path; decisions recorded; stop switch | Pass: FR-027, FR-051, FR-054 | Pass: answering model with fixed-reply fallback; decision record on every action; stop switch checked first by the scheduler (R5) |
| VII. Proven Against Failure | Tests first; fault-injecting fakes; load test at claimed size | Pass: SC-004, SC-007 | Pass: R11 fault suite and load stage; [quickstart.md](quickstart.md) sections 1 and 5 |
| Operating Constraints | One repo per run; DAG v1 `story`; Rovara sign-in; least-privilege App; secrets in a secret store; traces only on the status page; Slack only; generic upstream issues | Pass | One deviation, in Complexity Tracking: a development-only operator identity in non-production stages until Rovara#442 |

**Result**: pass, with one justified deviation.

## Project Structure

### Documentation (this feature)

```text
specs/001-dag-orchestrator/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   ├── operator-api.md
│   ├── cli.md
│   ├── rovara-channel.md
│   ├── github-app.md
│   └── notifications-and-answers.md
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
packages/
├── core/          # pure domain: node, attempt and run state machines; scheduler pick();
│                  # merge gate; back-off; brief and fix-request text builders. No I/O.
├── store/         # DynamoDB items and transactions (data-model.md); intents; leases and locks
├── dag-import/    # speckit-dag v1 validation, hash recomputation, remote-commit check
├── rovara/        # channel adapter client: signed requests, callback verification,
│                  # pinned contract copies (R4)
├── github/        # App auth, webhook verification, GraphQL merge queue and review threads
├── slack/         # notification posts and thread replies
├── answerer/      # Claude Opus 5.5 on Bedrock; structured output; fixed-reply fallback (R8)
├── identity/      # OperatorIdentity: Rovara tokens and access check; dev-only implementation
├── api/           # operator API handlers (contracts/operator-api.md)
├── workers/       # Lambda entry points: ingress, work consumer, intent runner, scheduler, sweep;
│                  # effects/ (one executor per intent effect), github-events/, hooks/ (Rovara event hooks)
├── cli/           # rovara-orch (contracts/cli.md)
├── web/           # status page (React + Vite)
└── testkit/       # fakes of Rovara, GitHub, Slack and the model, with fault injection

infra/             # AWS CDK app: table, queues, functions, API, page hosting, alarms; stages
                   # test, load, prod; infra/test/ holds CDK assertion tests for each stack

scripts/           # repository scripts (fetching Rovara's contracts at the pinned commit)
docs/              # operator runbook

tests/
├── contract/      # Rovara schemas at the pinned commit; recorded GitHub payloads
├── integration/   # packages wired together on DynamoDB Local
├── fault/         # whole DAGs with restarts and injected delivery faults (SC-004 to SC-006)
├── e2e/           # TEST stage against Rovara TEST and the test monorepo (SC-001)
└── load/          # load-stage driver (SC-003, SC-007, SC-009)
```

**Structure Decision**: one npm-workspaces repository. `core` holds every decision as pure code, so
the scheduler and state machines are tested without I/O. Each outside system has one package, so
its fake in `testkit` replaces exactly one thing. Unit tests sit next to the code in each package
(`*.test.ts`); cross-package tests live under `tests/`.

## Decisions that resolve open points in the spec

- **A check report of `unknown`** is treated as failed: a fix request while fix requests remain,
  then a new attempt, then escalation. FR-040 already requires `passed` to merge.
- **Run cost** counts the answering model at once, and Rovara's per-task usage once Rovara#441
  delivers it. Until then the cost limit (FR-052) covers only the answering model, and the status
  page says so (R12).
- **Production launch gate**: Rovara#442 (sign-in), #437 (state read) and #441 (trace and usage),
  and an answer on #443. Everything else runs in TEST with the interim behaviour in R12.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Operators in non-production stages sign in with a development-only identity, not Rovara (Operating Constraints: Identity) | Rovara cannot yet issue tokens addressed to another service (Rovara#442), and everything else can be built and tested before it does | Accepting Rovara's own developer tokens would hand the orchestrator credentials that work against Rovara (the risk #442 describes); waiting for #442 would block all other work. Production refuses to start with the development identity |
