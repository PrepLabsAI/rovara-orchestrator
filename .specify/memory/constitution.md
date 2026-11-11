# Rovara Orchestrator Constitution

## Core Principles

### I. Thin Orchestrator

The orchestrator schedules, supervises, merges and cleans up. It MUST NOT plan work, write or
change product code, or build or edit DAGs. Coding, planning inside a node and the node's own
checks belong to Rovara; building DAGs belongs to speckit-dag or another producer of the same
format. A feature that would make the orchestrator do any of these MUST be refused or moved to
the system that owns it.

Rationale: every responsibility the orchestrator takes from Rovara or the DAG builder is one it
must also get right at 1000 concurrent nodes.

### II. Immutable DAGs

A stored DAG MUST NOT change after import. Its identity is its content hash and source commit; the
same graph imported twice MUST get the same dag-id. A changed spec is a new import and a new run,
never an edit to a running one. A DAG MUST be refused when its spec files are not committed and
pushed, because Rovara's workspaces cannot see them.

Rationale: a run can only be audited and resumed if the graph it ran is the graph on record.

### III. Exactly-Once Effects

Every decision MUST be stored before it is acted on, and every action on Rovara or GitHub MUST be
safe to repeat. A restart at any point MUST NOT create a second conversation, decision, pull
request or merge for the same attempt. A node MUST NOT start before every node it depends on has
merged (or been skipped by an operator). When the orchestrator does not know a node's state, it
MUST read the record from Rovara or GitHub, or escalate; it MUST NOT guess and retry.

Rationale: at this scale, lost and duplicated events are normal, and duplicated work in one
monorepo costs money and causes conflicts.

### IV. Rovara Through Its Contracts

The orchestrator MUST talk to Rovara only through Rovara's published interfaces: the channel
adapter API, its sign-in, and its admin settings. It MUST NOT read or write Rovara's storage,
queues or internals, or depend on reply wording. Every Rovara action MUST be made for a named
operator, so that Rovara's records name a person. A missing capability MUST be requested
upstream as a Rovara issue and listed in the feature's Dependencies; it MUST NOT be worked around
by bypassing Rovara's checks.

Rationale: Rovara changes quickly; its contracts are what both projects agree to keep stable.

### V. Gated Merges

The orchestrator MUST merge only through its own GitHub App and the repository's merge queue, and
only the pull request Rovara reported for a node's current attempt. A merge MUST require all of:
Rovara's check report `passed`, a non-empty change, the repository's AI review tool having reviewed
the latest commit with nothing unresolved, and the required CI checks passing on the pull request
and in the merge queue. When main's required checks fail, dispatch and merges on that repository
MUST stop until main is green.

Rationale: no person reviews these merges, so the gates are the only protection main has.

### VI. Unattended but Attributable

The normal path from import to merge MUST need no person. The orchestrator answers the agent's
questions with a separate AI model and never escalates for a question. Escalation is reserved for
nodes out of retries, administrator-only requests, and a broken main. Every automatic and human
decision (approve, answer, merge, retry, skip, escalate, pause, take over) MUST be recorded with
its actor and reason. An operator MUST always be able to pause a run, cancel it, or stop every
run at once.

Rationale: unattended work at scale is only acceptable if anyone can see afterwards why each
thing happened, and stop it immediately.

### VII. Proven Against Failure

Every behaviour MUST be proven by an automated test before it runs against a real Rovara or
GitHub. Write the test first and watch it fail. Tests MUST use fakes of Rovara, GitHub, Slack and
the answering model that can inject duplicate, delayed, dropped and out-of-order events and
restarts at any step. Claims about scale (concurrency, latency, throughput) MUST be backed by a
load test at the claimed size.

Rationale: the failures that matter here (lost events, restarts, races between nodes) do not show
up in a happy-path demo.

## Operating Constraints

- **One repository per run.** A run targets one monorepo, with GitHub's merge queue on for main.
  Several runs may share the monorepo; file-overlap and stop-the-line rules apply across them.
- **DAG format.** The orchestrator accepts the speckit-dag JSON format, version 1, with
  `unit: story`. Another version is a constitution-level change to Principle II's inputs.
- **Identity.** Operators sign in with Rovara and are Rovara administrators or people with access
  to the monorepo's Rovara project. The orchestrator's GitHub App MUST hold only the permissions
  needed to read pull requests, checks and review comments, and to merge through the queue.
- **Secrets.** The adapter's signing secret, the GitHub App's key and the Slack token MUST live in
  a secret store, never in code, configuration files or logs.
- **Traces.** The agent trace is shown only on the operator status page, as Rovara sent it after its
  own credential removal, and kept with the attempt for at least 90 days after the run ends.
- **Notifications.** People are told through one configured Slack channel.
- **Public upstream.** Rovara is a public repository. Issues filed there MUST describe the
  orchestrator in generic terms and MUST NOT link this repository or include private details.

## Development Workflow

- Every feature follows Spec Kit: specify, clarify, plan, tasks, implement. Each has a folder under
  `specs/`. The plan MUST pass this constitution's check before tasks are written.
- Work happens on a feature branch and reaches main by pull request with CI passing.
- A change to a contract with Rovara, GitHub, Slack or the DAG format MUST update the feature's
  spec and its Dependencies table in the same pull request.
- Tests ship with the code that makes them pass; a pull request that adds behaviour without a
  failing-first test MUST be sent back (Principle VII).

## Governance

This constitution overrides other practice in this repository. Every plan's Constitution Check
and every pull request review MUST check compliance; a violation MUST be fixed or recorded in the
plan's Complexity Tracking with a reason and a simpler alternative that was rejected.

Amendments are made by pull request that changes this file. They state the version change and the
reason, and update any spec or plan that the change affects. Versions follow semantic
versioning: MAJOR for removing or redefining a principle, MINOR for adding a principle or section
or materially expanding one, PATCH for wording and clarifications.

Runtime development guidance lives in `CLAUDE.md` at the repository root once it is written.

**Version**: 1.0.0 | **Ratified**: 2026-11-11 | **Last Amended**: 2026-11-11
