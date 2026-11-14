# Research: DAG Orchestrator for Rovara

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Date**: 2026-11-11

Each entry records one decision the plan depends on: what was chosen, why, and what else was
considered. Facts about Rovara were read from `PrepLabsAI/Rovara` `mainline` at `c35d5967`
(2026-11-11).

## R1. Language and runtime

**Decision**: TypeScript on Node.js 22 (22.19 or later), npm workspaces, ES modules.

**Rationale**: Rovara is TypeScript on Node 22.19+ with zod schemas for every channel contract
(`packages/contracts/src/channel-adapter.ts`). Using the same language lets the orchestrator check
Rovara's event and request shapes with the same schema library, and lets contract tests compare
the orchestrator's copies with Rovara's files directly (R4). The AWS CDK, the Anthropic SDK, the
GitHub (Octokit) and Slack SDKs all have first-class TypeScript clients.

**Alternatives considered**: Go (one static binary, strong concurrency), rejected because every
Rovara contract would have to be re-expressed by hand with no shared schema language. Python,
rejected for the same reason and for weaker typing at the event boundaries.

## R2. Where it runs and how work is driven

**Decision**: AWS, in the same account and region as the Rovara install it drives. Event-driven:

- **Ingress**: one API Gateway HTTP API. Routes: Rovara callbacks, GitHub webhooks, operator API.
  Each callback route verifies its signature, writes the raw event to storage, puts a message on a
  queue and returns 2xx. It does no other work.
- **Work queue**: SQS FIFO with three kinds of message group, each handled in order while
  thousands run in parallel. A Lambda consumer runs the matching state machine for each message:
  - `att:<attemptId>`: Rovara and GitHub events, and timers, for one attempt (attempt machine);
  - `run:<runId>`: run start (capacity check), pause, resume, cancel, take-over, and the
    cost-limit and lost-access pauses (run machine);
  - `repo:<owner/name>`: main going red or green (repository machine).

  A run or repository handler changes only its own item. To affect attempts it writes one
  `queue.enqueue` intent per affected attempt (a run cancel writes a cancel for each running
  attempt's group), carried out like any other effect (R3), so every
  attempt still changes state only in its own group, and a cancel and a merge on the same attempt
  are always ordered.
- **Scheduler**: a Lambda run after every transition that may free capacity or unblock a node
  (merged, skipped, escalated, cancelled, back to waiting), at most once per repository every 5
  seconds, and by EventBridge Scheduler once a minute as a sweep. It picks eligible nodes and
  starts them (R5).
- **Timers**: the same one-minute sweep fires quiet timeouts, review-wait timeouts and retry
  delays, from due-times stored on each attempt.
- **Status page**: a static single-page app on S3 behind CloudFront, reading the operator API.

**Rationale**: the load is bursty and event-shaped (Rovara events, GitHub webhooks, operator
commands), from zero to thousands of attempts. Lambda and SQS scale with it and cost nothing while
idle. FIFO message groups give per-attempt ordering without a lock service. Rovara itself runs on
API Gateway, Lambda, SQS and DynamoDB, so the team runs one kind of stack.

**Alternatives considered**:
- *One long-running service (ECS Fargate)*: simpler to reason about at first, but a single process
  is a single point of failure for 1000 nodes, and scaling it out needs the same per-attempt
  ordering and locking that FIFO groups give for free.
- *AWS Step Functions, one execution per node*: durable waits and retries are attractive, but
  scheduling decisions span nodes (concurrency, file overlap, stop-the-line), so a central scheduler
  is needed anyway. Step Functions would also make Principle VII's fault-injection tests harder to
  run locally.
- *Temporal*: strong durable workflows, but a new cluster to run and secure, for problems the
  queue-plus-table design already covers.

## R3. Storage and exactly-once effects

**Decision**: DynamoDB, one table, on-demand capacity, point-in-time recovery on; trace steps in
the same table with a TTL. Every effect on the outside world uses the **intent pattern**:

1. In one conditional transaction, the state machine moves the attempt to its next state and
   writes an *intent* item (`INTENT#<attempt>#<step>`) naming the effect (send message, post
   decision, enqueue pull request, post to Slack...) and its idempotency key.
2. A DynamoDB stream consumer carries out each new intent and marks it done.
3. Every effect is idempotent at the far end: Rovara drops a repeated `eventId`; GitHub's
   `enqueuePullRequest` is keyed by pull request and expected head commit; Slack posts store
   their message `ts` on the intent and are not resent once it is set.

The transaction's condition is the attempt's current version, so two consumers cannot both move
it. A restart re-reads intents not yet done and carries them out.

Queueing an input is an effect like any other. A transition, or an operator API call, that needs
another input queued writes a `queue.enqueue` intent in the same transaction as its own change, and
the intent runner sends it with the intent's key as the SQS FIFO deduplication id, so a resend is
dropped. Nothing sends to the queue directly, so a crash between "stored" and "queued" cannot lose
an input. The Rovara and GitHub ingresses follow the same rule: the event's repeat marker, the
stored event and its enqueue intents are one transaction, and the sender gets its 2xx only after
it commits, so a resend after a crash is either dropped as already handled or handled for the first
time, never lost. The one exception is the sweep, which recomputes its timer inputs and scheduler
passes from stored state every minute, so a lost send is repeated by the next sweep.

**Rationale**: Principle III demands that every decision is stored before it is acted on and that
restarts cause no duplicates. The intent pattern makes that a property of one table write, which
can be tested by killing the process between any two steps (R11).

**Alternatives considered**: PostgreSQL (Aurora Serverless), with richer queries for the status
page, rejected because the hot paths are key lookups and conditional updates that DynamoDB handles
at any scale with no connection management; the status page's few aggregate views are kept as
counters on the run item. A separate trace store (S3, OpenSearch) was rejected for v1: steps are at
most 64 KB each, matching DynamoDB's item limit with room to spare.

## R4. Consuming Rovara's contracts

**Decision**: Keep the orchestrator's own zod copies of the channel-adapter shapes it uses, in
`packages/rovara/src/contract/`. A contract test fetches Rovara's
`packages/contracts/src/channel-adapter.ts` and `conversation.ts` at a pinned commit and checks,
by fixtures, that every event Rovara can send parses with our copy and every request we send parses
with Rovara's. Bumping the pinned commit is a reviewed change.

**Rationale**: Rovara does not publish its contracts package to npm. A git dependency on the whole
Rovara monorepo would pull its build into ours. Pinned copies plus a contract test catch drift the
day it happens, and satisfy Principle IV (published interfaces only).

**Alternatives considered**: asking Rovara to publish `@agentx/contracts` (worth requesting later,
not blocking); generating types from Rovara at build time (couples our build to theirs).

## R5. Scheduling

**Decision**: The scheduler is a pure function, `pick(state) -> starts[]`, run under a per-repository
lease (a conditional write on `REPO#<repo>#LEASE`, renewed each pass), so only one pass per
repository runs at a time. Rules, in order:

1. Nothing starts while the global stop switch is on, the repository is paused (main red), or the
   run is paused, cancelled or over its cost limit.
2. A node is eligible when every dependency is merged or skipped (FR-011).
3. Capacity = min(run concurrency limit, the current start rate (R6), free Rovara workspaces as last
   reported). A Rovara workspace-limit refusal returns the node to waiting with no attempt used
   (FR-062).
4. Order: MVP nodes first, then priority (P1 before P2...), then DAG order.
5. File overlap (FR-022): a node is skipped this pass when any file it lists is held by a running
   node in any run on the repository. Files are held from start until merge, as a set of
   `REPO#<repo>#FILE#<path>` lock items written in the same transaction that starts the node.
   Directories are not locked, matching speckit-dag.

**Rationale**: a pure function can be checked by property tests over random DAGs (no dependency
started early, no two overlapping nodes running, capacity never exceeded). The lease gives one
writer per repository without a lock service.

**Alternatives considered**: per-run schedulers, rejected because file overlap and stop-the-line
cross runs on one repository; a global single scheduler, rejected because independent repositories
need not wait for each other.

## R6. Back-off under throttling

**Decision**: Additive-increase, multiplicative-decrease on the start rate, per repository: halve
when more than 10% of start requests in the last 5 minutes were refused for throttling; add one
step (10% of the run's concurrency limit) after each 5-minute window with none (FR-063). Rovara
signals throttling as an `error` event or an HTTP 429 on the messages route.

**Rationale**: the spec fixes the thresholds. AIMD converges without oscillating and needs only two
counters per repository.

## R7. GitHub: merging, review and main health

**Decision**: One GitHub App, installed on the monorepo only.

- **Webhooks**: `pull_request`, `pull_request_review`, `pull_request_review_comment`,
  `pull_request_review_thread`, `check_suite`, `check_run`, `status`, `merge_group`, `push` (main).
- **Merging**: GraphQL `enqueuePullRequest` with `expectedHeadOid` set to the head Rovara's checks
  ran on, so a later push cannot be merged unchecked. Merged = the pull request's merge commit is
  reachable from main (FR-043).
- **Review tool**: comments are recognised by the tool's GitHub login (configurable;
  `coderabbitai[bot]` for CodeRabbit). Unresolved threads are read through GraphQL
  `reviewThreads`. The orchestrator resolves a thread with `resolveReviewThread` once Rovara has
  fixed or answered it (FR-045). A re-review is requested with a configurable comment
  (`@coderabbitai review` for CodeRabbit) (FR-046).
- **Main health**: the required checks of main's latest commit, from `check_suite` / `status`
  webhooks, confirmed by a read before resuming.
- **Permissions**: metadata read, contents write (GitHub requires it to merge), pull requests
  write, checks read, commit statuses read. Nothing else.

**Rationale**: the merge queue is GitHub's own answer to many PRs racing for one main. The
expected-head check closes the gap between "checked" and "merged". Treating the review tool as a
configurable bot login keeps CodeRabbit swappable.

**Alternatives considered**: direct merges with our own serialisation (reimplements the merge
queue, badly); using Rovara's `sync` pull request action for every update (kept, but only for
conflicts, FR-042).

## R8. Answering the agent's questions

**Decision**: Claude Opus 5.5 on Amazon Bedrock, through the Anthropic TypeScript SDK's Bedrock
Mantle client (`AnthropicBedrockMantle` from `@anthropic-ai/bedrock-sdk`), model
`anthropic.claude-opus-5-5`, in the orchestrator's account and region.

- **Prompt**: system prompt (fixed) + the spec folder's documents and the node's tasks at the DAG's
  commit (the same for every question in a DAG, so they sit before a prompt-cache breakpoint) +
  the question and its choices.
- **Output**: structured output (`output_config.format`) with `{ answer, choice?, confidence,
  citations[] }`; `answer` is sent to Rovara unchanged (FR-027).
- **Thinking and effort**: adaptive thinking (the only mode on Opus 5.5) at effort `high`, set
  explicitly because Opus 5.5 defaults to `medium`. Streaming, with `finalMessage()`.
- **Refusals**: always check `stop_reason`. Bedrock does not support server-side `fallbacks`, so use
  the SDK's client-side `BetaRefusalFallbackMiddleware`; if the answer is still a refusal, or the
  model cannot be reached after 3 tries, send the fixed reply (FR-027, Edge Cases).
- **Model id is configuration**, so the first-party Claude API can replace Bedrock without a code
  change.

**Rationale**: Rovara's own installs run their models on Bedrock in the same account, so this
needs no new vendor account, keys or data flow outside AWS. Structured outputs and prompt caching
are both available on Bedrock. Caching the spec folder makes repeated questions in one DAG cheap.

**Alternatives considered**: the first-party Claude API (same model, separate API key and egress;
kept as a configuration option); a smaller model to save cost (not chosen: a wrong answer here goes
straight into main, and question volume is low next to coding cost).

## R9. Operator sign-in

**Decision**: Operators sign in with Rovara (Slack or company login). The CLI uses the terminal
flow and the status page the browser flow that Rovara will offer registered clients (D11,
PrepLabsAI/Rovara#442). The operator API verifies tokens addressed to the orchestrator against
Rovara's sign-in keys, and calls Rovara's access check on every action (FR-054).

Until #442 ships, the operator API runs behind an `OperatorIdentity` interface with one
development-only implementation (a fixed operator list, allowed only in non-production stages). A
production deployment refuses to start with that implementation.

**Rationale**: the clarified decision (Rovara sign-in), with no unsafe shortcut while the Rovara
side is missing: accepting Rovara's own tokens would let anything we receive act on Rovara.

## R10. Live trace on the status page

**Decision**: The orchestrator stores trace steps as Rovara sends them (D10,
PrepLabsAI/Rovara#441). The status page polls the operator API for a node's steps after a sequence
cursor every 2 seconds while the node page is open and the node is running.

Until #441 ships, the trace shows what adapters receive today (`progress`, `message`,
`check_report`, `pr` events) and says that the full trace needs a Rovara update.

**Rationale**: polling with a cursor meets "within 10 seconds" (FR-055, SC-009) with Rovara's own ~5
second batching, works through CloudFront with no connection state, and costs one key-range read
per open page.

**Alternatives considered**: WebSockets (API Gateway WebSocket API) or server-sent events, rejected
for v1 because they add connection state for a read-only page used by a few operators.

## R11. Testing approach

**Decision**:

- **Unit and property tests** (Vitest, fast-check) for the pure core: node state machine, run state
  machine, scheduler `pick`, merge-gate evaluation, back-off.
- **Fakes** in `packages/testkit`: a fake Rovara (channel API and callbacks, scriptable per
  conversation), fake GitHub (webhooks, GraphQL subset), fake Slack, fake answering model. Each fake
  can duplicate, delay, drop and reorder deliveries.
- **Fault suite**: runs whole DAGs against the fakes on DynamoDB Local, stopping the process at
  every intent boundary and restarting it; asserts no duplicate conversation, pull request or merge
  (SC-004).
- **Contract tests**: R4 for Rovara; recorded GitHub webhook payloads for GitHub.
- **End-to-end**: a TEST stage against a Rovara TEST install and a test monorepo (SC-001).
- **Load**: the fake Rovara deployed as a Lambda in a load stage, 1200-node DAG at concurrency 1000
  (SC-007, SC-009).

**Rationale**: Principle VII; the failures that matter are restarts and lost or repeated events.

## R12. What works before each Rovara dependency lands

| Dependency | Until it lands | Requirement held back |
|---|---|---|
| D1 #430 project limits | Concurrency capped at the operator's per-person limit (at most 50). Once it lands, the orchestrator requests a higher project limit through Rovara's admin change path only for an operator who is a Rovara administrator; otherwise it reports that it cannot (FR-061) | US6 |
| D2 #437 state read | A node quiet past its timeout is escalated, not retried (FR-034) | US3 scenario 3 is weaker |
| D3 #438 typed fields | Pull request number from the `pr` URL; head commit and state read from GitHub; attempt identified by conversation | none (GitHub is authoritative) |
| D4 #439 typed close/cancel | Send Rovara's documented phrases (`close this workspace`, `stop`); record "close requested"; never read the reply text | FR-026, FR-050 cannot confirm closure |
| D5 #440 adapter limits | No per-adapter limit; Rovara's person and organization limits apply | US6 |
| D6 #443 constitution question | Build as specified; production merging waits for the answer | FR-041 in production |
| D7 adapter commands (#428) | Register the adapter through Rovara's admin interface | none |
| D9 repository setup | Set up by hand per quickstart.md | FR-040, FR-045 |
| D10 #441 trace stream | Conversation-level events only; run cost counts the answering model only, since per-task usage arrives with the trace stream | FR-055 (full trace), FR-052 (cost limit) |
| D11 #442 sign-in for services | Development-only operator identity in non-production stages | Production launch |

**Launch gate**: production needs D11, D2 and D10, and an answer on D6. Everything else can run in
TEST with the interim behaviour above.
