# Feature Specification: DAG Orchestrator for Rovara

**Feature Branch**: `001-dag-orchestrator`

**Created**: 2026-11-10

**Status**: Draft

**Input**: User description: "An orchestrator that coordinates 1000+ coding agents across machines toward a common goal. It takes a DAG of work prepared up front (by speckit-dag), keeps track of which work is unblocked, hands each piece to Rovara, which creates a workspace on EC2 and does the coding, makes sure Rovara completes it, merges the result through the orchestrator's own GitHub App, and closes the workspace."

## Overview

```
spec folder ──speckit-dag──► DAG JSON ──import──► stored DAG (dag-id)
                                                       │ start run
                                                       ▼
                           ┌──────────────── orchestrator ────────────────┐
                           │ scheduler: which nodes are unblocked          │
                           │ one Rovara conversation per node attempt      │
                           │ merge service: the orchestrator's GitHub App  │
                           └──────┬───────────────────────────▲───────────┘
                    message, decision                 signed events
                                  ▼                           │
                     Rovara (channel adapter API) ── EC2 workspace ── draft PR
                                                                         │
                                         GitHub merge queue ◄── orchestrator merges
```

A **node** is one unit of work from `speckit-dag --unit story`: Setup, Foundational, one user story, or
Polish. One node is one Rovara workspace and one pull request. The target is one monorepo.

The orchestrator does not plan, write code or build the DAG. It schedules, supervises, merges and
cleans up.

## Clarifications

### Session 2026-11-11

- Q: When Rovara's agent stops mid-task to ask a question, who answers it? → A: A separate AI model answers it from the node's tasks and spec folder, and that answer is sent back. Questions are never escalated to a person.
- Q: When something needs a person, where does the orchestrator tell them? → A: A Slack message in one configured channel, one per escalation, with links to the node, its Rovara task and its PR.
- Q: Before the orchestrator merges a node's PR, what review must it pass beyond checks? → A: An AI review tool configured on the repository (CodeRabbit or similar). The orchestrator reads its comments, has Rovara address every one, and merges only when the review has nothing unresolved and CI passes.
- Q: How do operators work with the orchestrator? → A: A command line for every action, plus a read-only web page. For each node the page shows its status, every PR it raised, and a live trace of the agent's work: its messages and reasoning, tool calls and results, and check runs. This needs Rovara to stream the agent's events to the orchestrator (Dependency D10).
- Q: How do operators sign in, and who counts as an operator? → A: With Rovara's own sign-in (Slack or company login), since the work runs on Rovara. Operators are Rovara administrators and people with access to the monorepo's Rovara project.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Import a DAG and get a dag-id (Priority: P1)

An operator has run `speckit-dag --unit story --strict` on a spec folder in the monorepo and has the
JSON file. They import it. The orchestrator checks it and stores it, and returns a dag-id that will
always mean exactly this graph. Importing the same graph again returns the same dag-id. A graph built
from uncommitted or unpushed spec files is refused, because Rovara's workspaces clone from GitHub
and would not see those files.

**Why this priority**: Every run starts from a stored DAG. Nothing else can be built or tested
without it.

**Independent Test**: Import `examples/output/units.json` from speckit-dag: a dag-id is returned and
the stored graph shows the same nodes, edges and hash. Import it again: the same dag-id. Import a
copy with one task's text changed: a new dag-id. Import a graph with `spec.dirty: true`: refused,
with the reason.

**Acceptance Scenarios**:

1. **Given** a valid speckit-dag JSON file with `unit: "story"`, **When** the operator imports it,
   **Then** the orchestrator stores it unchanged and returns a dag-id.
2. **Given** a DAG already imported, **When** the operator imports a file with the same hash from the
   same repository, **Then** the orchestrator returns the existing dag-id and stores nothing new.
3. **Given** a file whose recorded hash does not match its content, **When** imported, **Then** it is
   refused and the reason names the mismatch.
4. **Given** a file whose spec commit is not on the remote, or whose spec folder had uncommitted
   changes, **When** imported, **Then** it is refused and the reason says which.
5. **Given** a file that does not match the speckit-dag schema, contains a cycle, or has an edge to an
   unknown node, **When** imported, **Then** it is refused and the reason names the first problem.
6. **Given** stored DAGs, **When** the operator lists or shows them, **Then** they see each dag-id,
   feature, source repository and commit, node count, hash and import time.

---

### User Story 2 - Run a DAG to completion with no person involved (Priority: P1) 🎯 MVP

The operator starts a run for a dag-id. The orchestrator sends every unblocked node to Rovara, up to
the run's concurrency limit. For each node it approves Rovara's plan, waits for the checks, has
Rovara open the pull request, merges it through the orchestrator's GitHub App, closes the workspace
and unblocks the nodes that depended on it. The run ends when every node is merged.

**Why this priority**: This is the product. With US1 it is the smallest version worth using.

**Independent Test**: On a test monorepo bound to a test Rovara install, import a 3-node DAG
(Foundational → US1, US2 in parallel) and start a run. Three pull requests merge, Foundational first,
and no workspace is left open. Restart the orchestrator part-way through: the run finishes with no
duplicate workspace or pull request.

**Acceptance Scenarios**:

1. **Given** a stored DAG, **When** the operator starts a run with a concurrency limit, **Then**
   every node with no unmerged dependency is sent to Rovara, at most the limit at once.
2. **Given** a node sent to Rovara, **When** Rovara asks for plan approval, **Then** the orchestrator
   approves it and records the decision against the run, node and attempt.
3. **Given** Rovara reports the node's checks passed, **When** no pull request exists yet, **Then**
   the orchestrator asks Rovara to open one.
4. **Given** Rovara reports a pull request for the node, **When** the merge conditions hold
   (FR-040), **Then** the orchestrator merges it through its GitHub App.
5. **Given** a node's pull request is merged, **When** the merge is confirmed on the main branch,
   **Then** the orchestrator closes the node's Rovara workspace, marks the node merged and makes its
   dependents eligible.
6. **Given** a node's dependencies are all merged, **When** it is sent to Rovara, **Then** its work
   starts from the main branch at or after the last of those merges.
7. **Given** every node is merged, **When** the last merge is confirmed, **Then** the run is marked
   complete with its duration and total cost.
8. **Given** a node marked `done` in the imported DAG, **When** the run starts, **Then** it is treated
   as merged and not sent to Rovara.
9. **Given** the repository's AI review tool leaves comments on a node's pull request, **When** the
   orchestrator reads them, **Then** it asks Rovara, in the same conversation, to address each one,
   and merges only after the tool's next review leaves nothing unresolved and CI passes.

---

### User Story 3 - Failed nodes retry, then escalate without stopping unrelated work (Priority: P2)

Agents fail: checks stay red, workspaces fail to start, results come back unknown, Rovara goes
quiet. The orchestrator retries within limits. When a node runs out of retries, it is escalated to a
person. Its dependents wait, and every other branch of the DAG keeps going. The operator can retry,
skip or cancel an escalated node.

**Why this priority**: At 1000 nodes some will fail every run. Without this, one failure stalls
the run or needs constant watching.

**Independent Test**: In a run against a fake Rovara, make one node's checks fail every time. That
node retries up to its limit and is escalated. Its dependent stays blocked, and an unrelated node
still merges. The operator retries the escalated node after a fix and the run completes.

**Acceptance Scenarios**:

1. **Given** Rovara reports failed checks, **When** the node has fix attempts left, **Then** the
   orchestrator asks Rovara, in the same conversation, to fix the failures.
2. **Given** a workspace that fails to start or a conversation that ends in an error, **When** the
   node has attempts left, **Then** the orchestrator starts a new attempt in a new conversation.
3. **Given** no event for a node for longer than its quiet timeout, **When** the orchestrator
   checks the node's state with Rovara, **Then** it continues, retries or escalates based on that
   state, never on a guess.
4. **Given** a node out of attempts, **When** it fails again, **Then** it is escalated: a Slack message
   goes to the notification channel, its dependents stay blocked, and other nodes continue.
5. **Given** an escalated node, **When** the operator chooses retry, skip or cancel, **Then** the
   orchestrator records who chose it and why. Skip marks the node complete without a merge, and is
   shown as skipped, never as merged.

---

### User Story 4 - Merges keep flowing in a busy monorepo (Priority: P2)

Many nodes finish at about the same time and all target one main branch. The orchestrator merges
through the merge queue. When a pull request conflicts with main, it asks Rovara to bring the branch
up to date and resolve the conflict. It avoids starting two nodes that touch the same files. If main
goes red, it stops merging and dispatching until main is green again.

**Why this priority**: In one monorepo the speed of the whole run is set by how fast main accepts
merges, not by how many agents are running.

**Independent Test**: Run a DAG where two parallel nodes edit the same file: they do not run at the
same time. Force a conflict on a third node's pull request: Rovara is asked to update it, and it
merges. Make main's checks fail: no new node starts and no pull request merges until main is green.

**Acceptance Scenarios**:

1. **Given** two eligible nodes whose file lists overlap, **When** one is running, **Then** the
   other waits until the first is merged, and the wait is shown with its reason.
2. **Given** a node's pull request conflicts with main or is removed from the merge queue for being
   out of date, **When** the node has update attempts left, **Then** the orchestrator asks Rovara to
   update the pull request from main and fix the conflict, then queues it again.
3. **Given** the main branch's required checks fail after a merge, **When** the orchestrator sees it,
   **Then** it pauses dispatch and merges for every run on the repository, posts to the notification channel, and
   resumes when main is green.

---

### User Story 5 - See and control a run (Priority: P2)

The operator opens a read-only web page and sees each run at a glance: how many nodes are in each
node state (waiting, eligible, running, checks failed, PR open, in merge queue, merged, escalated,
skipped, cancelled); what each node is waiting for; and what the run has cost so far. They open a
node and see every pull request it raised and a live trace of what the agent is doing: what it
said and reasoned, which tools it ran and what came back, and which checks ran. They pause, resume
or cancel a run, or stop everything at once, from the command line.

**Why this priority**: A 1000-node run lasts hours or days. People need to know where it stands and
be able to stop it.

**Independent Test**: During a run, open its page and one running node's page, and watch the
agent's steps appear while it works; pause the run from the command line and see
that no new node starts while running nodes finish; resume; cancel and see every open workspace
closed and every open pull request closed.

**Acceptance Scenarios**:

1. **Given** a run, **When** the operator opens its page, **Then** they see counts per node state, the
   cost so far, and for each node its state, attempt, Rovara task link, pull request links and what
   it waits for.
2. **Given** a running run, **When** the operator pauses it, **Then** no new node starts, running
   nodes continue to their next decision point, and merges continue.
3. **Given** a run, **When** the operator cancels it, **Then** running Rovara tasks are cancelled,
   their workspaces closed, and the run's unmerged pull requests closed.
4. **Given** the global stop switch, **When** an operator turns it on, **Then** no run starts a node,
   approves a plan or merges until it is turned off.
5. **Given** a run with a cost limit, **When** its cost reaches the limit, **Then** no new node starts
   and a message goes to the notification channel.
6. **Given** someone who is not an operator (FR-054), **When** they try to import, start, pause,
   resume or cancel, **Then** the action is refused, and the refusal is recorded.
7. **Given** a running node, **When** the operator opens its page, **Then** they see the agent's
   trace for every attempt so far, and each new step appears within 10 seconds of the agent
   finishing it, without reloading the page.
8. **Given** a node whose attempt has ended and whose Rovara workspace is closed, **When** the
   operator opens its page, **Then** the full trace of every attempt is still there.

---

### User Story 6 - Run at 1000+ concurrent nodes (Priority: P3)

The operator raises a run's concurrency to 1000 or more. The orchestrator sets the Rovara project's
workspace limit through Rovara's settings to match, and slows down instead of failing when Rovara,
AWS or the model provider pushes back.

**Why this priority**: The goal is 1000+, but correctness at 50 comes first, and this depends on
Rovara changes that are not built yet (Dependencies D1, D2).

**Independent Test**: Against a load-test Rovara, run a 1200-node DAG with concurrency 1000.
Concurrency reaches 1000; a refusal for a full workspace limit is retried later and not counted as a
failure; no node is lost or sent twice.

**Acceptance Scenarios**:

1. **Given** a run whose concurrency exceeds the Rovara project's workspace limit, **When** the run
   starts, **Then** the orchestrator requests a matching limit through Rovara's settings, or reports
   that it cannot and runs at the current limit.
2. **Given** Rovara refuses a new conversation because a workspace limit is reached, **When** the
   refusal arrives, **Then** the node goes back to waiting, with no attempt used.
3. **Given** more than 10% of start requests in the last 5 minutes were refused for throttling,
   **When** the orchestrator next starts nodes, **Then** it starts them at half the rate, and raises
   the rate again after each 5-minute window without throttling (FR-063).

---

### Edge Cases

- **Duplicate, late or out-of-order events.** Rovara delivers events at least once. A repeated event
  changes nothing; an event for an old attempt is recorded but cannot move the current attempt.
- **Lost events.** An event that never arrives is caught by the quiet timeout and a state check with
  Rovara (FR-034).
- **Rovara asks a question mid-task.** A separate AI model answers it from the node's tasks and spec
  folder, and the orchestrator sends that answer back (FR-027). The node is never escalated for a
  question. If the model cannot be reached, the orchestrator sends a fixed reply instead: "Follow
  the spec; choose the simplest option that meets it, and list the choice in the PR description."
- **Rovara asks for an administrator's confirmation** (an `admin` kind approval). The orchestrator
  never approves it; the node is escalated.
- **A person merges or closes a node's pull request by hand.** A merge counts as the node merged. A
  close without merge counts as a failed attempt.
- **A pull request with no changes.** It is not merged; the attempt fails with that reason.
- **A pull request that is not the node's.** The orchestrator merges only the pull request Rovara
  reported for that node's current attempt, on the monorepo, targeting main.
- **The orchestrator restarts mid-run.** Every node resumes from its stored state; no workspace,
  pull request or merge is duplicated.
- **The same DAG is imported again with changes while a run is in progress.** It gets a new dag-id;
  the running run is unchanged.
- **A dependency is escalated and later skipped.** Its dependents become eligible; the skip is
  shown on the dependents too.
- **A run is started for a dag-id that already has an active run.** Refused.
- **Two runs on the same monorepo touch the same files.** File-overlap waiting (FR-022) applies
  across runs, not only within one.

## Requirements *(mandatory)*

### Functional Requirements

**Importing DAGs (US1)**

- **FR-001**: The orchestrator MUST accept the speckit-dag JSON format, version 1, and refuse a file
  that does not match its schema.
- **FR-002**: It MUST recompute the content hash the way speckit-dag does and refuse a file whose
  recorded hash differs.
- **FR-003**: It MUST refuse a graph with a cycle, an edge to an unknown node, `unit` other than
  `story`, a spec folder with uncommitted changes, or a spec commit that is not on the monorepo's
  remote.
- **FR-004**: It MUST assign each accepted graph a dag-id and store the graph unchanged. A stored
  graph MUST NOT change afterwards.
- **FR-005**: Importing a graph with the same hash from the same repository MUST return the existing
  dag-id.
- **FR-006**: Operators MUST be able to list stored DAGs and show one, with the fields in US1
  scenario 6.

**Runs and scheduling (US2, US4)**

- **FR-010**: Operators MUST be able to start a run for a dag-id with a concurrency limit and a cost
  limit. A dag-id MUST have at most one active run.
- **FR-011**: A node is eligible when every node it depends on is merged or skipped.
- **FR-012**: The orchestrator MUST start eligible nodes up to the run's concurrency limit, MVP
  nodes first, then by priority, then in DAG order.
- **FR-013**: A node marked `done` in the imported graph MUST count as merged.
- **FR-014**: A node's work MUST start from the main branch at or after the merge of its last
  dependency.

**Working with Rovara (US2, US3)**

- **FR-020**: The orchestrator MUST talk to Rovara only as a registered channel adapter (Rovara spec
  062), bound to the monorepo's project, registered so that it may make plan-approval decisions.
- **FR-021**: Each attempt of a node MUST be one Rovara conversation. The first message MUST name the
  node, include every task's full text in order, point to the spec folder and its documents at the
  DAG's commit, and ask for the work to be done in that order.
- **FR-022**: The orchestrator MUST NOT start a node while another running node, in any run on the
  same repository, lists any of the same files.
- **FR-023**: It MUST approve `plan_approval` requests for the node's current attempt, and MUST NOT
  approve requests of kind `admin`.
- **FR-024**: When Rovara reports the checks passed and no pull request exists, it MUST ask Rovara to
  open one.
- **FR-025**: It MUST verify every event's signature and timestamp, drop repeated events by event
  id, and ignore events that do not belong to a current attempt for state changes.
- **FR-026**: After a node is merged, or its attempt is abandoned, it MUST close that attempt's Rovara
  workspace.
- **FR-027**: The orchestrator MUST answer every question Rovara asks during an attempt. It MUST get
  the answer from an AI model other than the Rovara agent that asked, giving that model the
  question, any offered choices, the node's tasks and the spec folder's documents at the DAG's
  commit, and send the model's answer back unchanged. It MUST NOT escalate a node because of a
  question. When the model cannot be reached after 3 tries, it MUST send the fixed reply in Edge
  Cases. Each question, answer, answering model and its cost MUST be recorded, and the cost counts
  toward the run's cost (FR-052).

**Failures (US3)**

- **FR-030**: Each node MUST have limits on fix requests within an attempt, on attempts, on pull
  request updates and on review rounds (FR-045), with defaults set per run.
- **FR-031**: Failed checks MUST lead to a fix request in the same conversation while fix requests
  remain; a workspace failure or conversation error MUST lead to a new attempt while attempts remain.
- **FR-032**: A node that runs out of attempts MUST be escalated. Escalation MUST keep its
  dependents blocked, leave other nodes running, and notify people as in FR-035.
- **FR-035**: Every notification MUST be one Slack message in the orchestrator's configured
  notification channel: one per escalated node, per paused repository (FR-044), per run that reaches
  its cost limit (FR-052) and per Rovara request that needs an administrator. Each message MUST
  say what happened and why, and link to the run, the node, its Rovara task and its pull request
  where they exist. When the cause is resolved (the node is retried, skipped or cancelled, or main
  is green again), the orchestrator MUST reply in that message's thread saying how and by whom. If
  Slack cannot be reached, the notification MUST be retried and stay visible on the run's status
  until it is delivered.
- **FR-033**: Operators MUST be able to retry, skip or cancel an escalated node. Each choice MUST
  record who made it and why.
- **FR-034**: A node with no event for longer than its quiet timeout MUST be checked against
  Rovara's record of the conversation, and moved on only from that record. Until Rovara offers a
  way to read that record (Dependency D2), such a node MUST be escalated, not retried, so that no
  second workspace is started for work that may still be running.

**Merging (US2, US4)**

- **FR-040**: The orchestrator MUST merge a pull request only when all of these hold: it is the pull
  request Rovara reported for the node's current attempt; it targets main on the monorepo; Rovara's
  check report for it is `passed`; it has changes; the AI review tool has reviewed its latest commit
  and none of the tool's comments is unresolved (FR-045); and the repository's required CI checks
  pass, on the pull request and again in the merge queue.
- **FR-041**: Merges MUST go through the repository's merge queue, using the orchestrator's own
  GitHub App. The App MUST NOT merge any other pull request.
- **FR-042**: When a pull request conflicts with main or leaves the queue out of date, the
  orchestrator MUST ask Rovara to update it from main, while update attempts remain.
- **FR-043**: A node MUST count as merged only once its merge commit is on main.
- **FR-044**: When main's required checks fail, the orchestrator MUST pause dispatch and merges for
  every run on that repository, notify people (FR-035), and resume automatically when main is green.
- **FR-045**: For each node's pull request, the orchestrator MUST read the comments left by the
  repository's AI review tool on its latest commit, and ask Rovara, in the same conversation, to
  address every unresolved one: fix it with a new commit, or reply on it with the reason it should
  stand. A comment counts as resolved once its thread is resolved, either by the review tool or by
  the orchestrator after Rovara has fixed or answered it. Each set of comments sent to Rovara is one
  review round. A node that still has unresolved comments when its review rounds run out MUST be
  escalated. Every comment, and how it was resolved, MUST be recorded with the attempt.
- **FR-046**: When the review tool has not reviewed a pull request's latest commit within 30
  minutes, the orchestrator MUST ask the tool for a review once more. If there is still no review
  30 minutes later, the node MUST be escalated. A pull request is never merged without that review.

**Control and visibility (US5)**

- **FR-050**: Operators MUST be able to pause, resume and cancel a run. Cancel MUST cancel running
  Rovara tasks, close their workspaces and close the run's unmerged pull requests.
- **FR-051**: A global stop switch MUST prevent every run from starting nodes, approving plans and
  merging.
- **FR-052**: The orchestrator MUST total each run's cost from Rovara's usage records, and stop
  starting nodes when the run's cost limit is reached.
- **FR-053**: Every operator action MUST be available from a command line. Status MUST also be shown
  on a read-only web page that offers no actions: every run's node counts per state and cost, and
  every node's state, attempts, Rovara task link, every pull request it raised (with each one's
  state), what it waits for, its decision records and its trace (FR-055).
- **FR-054**: Operators MUST sign in with Rovara's sign-in, on the command line and on the status
  page. An operator is a person Rovara reports as an administrator, or as having access to the
  monorepo's Rovara project. The orchestrator MUST check this with Rovara on every action, so that
  someone whose Rovara access is removed is refused from their next action on. It MUST refuse import,
  start, pause, resume, cancel, node actions and the stop switch from anyone who is not an operator. Every such action, every refusal
  and every automatic decision (approve, answer, merge, retry, escalate, pause) MUST be recorded with its
  actor and reason.
- **FR-055**: For every attempt, the orchestrator MUST receive the agent's trace from Rovara as the
  agent works, and show it on the node's page: the agent's messages, its reasoning where the model
  provides it, each tool call with its input and result, check runs and their results, model
  retries and failures, and status changes, in order and with times. A step MUST appear on the page
  within 10 seconds of Rovara recording it, without the page being reloaded. The orchestrator MUST
  keep its own copy of each trace with the attempt, so the trace stays readable after Rovara's
  workspace is closed. Trace text MUST be shown as Rovara sends it, after Rovara's own removal of
  credentials; the orchestrator adds nothing to it and never shows it outside the status page.
- **FR-056**: The status page MUST use the operator sign-in and access check of FR-054.
- **FR-057**: A run's Rovara conversations MUST act for the operator who started the run, so that
  Rovara's own records name that person for every task, plan approval and pull request. If Rovara
  stops accepting work for that person (their access is removed or their sign-in link ends), the
  run MUST pause, post to the notification channel (FR-035), and resume only when another operator
  takes the run over, which is recorded.

**Durability and scale (US2, US6)**

- **FR-060**: The orchestrator MUST store each decision before acting on it, so that a restart at
  any point resumes without a duplicate conversation, decision, pull request or merge.
- **FR-061**: It MUST set the Rovara project's workspace limit through Rovara's settings when a run
  needs more than the current limit, or report that it cannot.
- **FR-062**: A refusal because a Rovara workspace limit is reached MUST return the node to waiting
  without using an attempt.
- **FR-063**: When more than 10% of its requests to start nodes in the last 5 minutes were refused
  for throttling, it MUST halve the rate at which it starts nodes. After each 5-minute window with no
  throttling refusals, it MUST raise the rate by 10% of the run's concurrency limit, back up to that
  limit.

### Key Entities

- **DAG**: An imported, unchangeable graph. dag-id, content hash, source repository, branch and
  commit, spec folder, feature name, unit, nodes, edges, import time and importer.
- **Node**: One unit of work in a DAG. Id, title, kind (setup, foundational, story, polish),
  priority, MVP flag, ordered tasks with full text, files it touches, dependencies.
- **Operator**: A person who signs in with Rovara and whom Rovara reports as an administrator or as
  having access to the monorepo's project. Identified by their Rovara developer identity.
- **Run**: One execution of a DAG. dag-id, state (running, paused, complete, cancelled), concurrency
  limit, cost limit, retry defaults, cost so far, start and end times, who started it, and the
  operator it currently acts for (FR-057).
- **Node state**: A node's progress within a run: waiting, eligible, running, checks failed, PR open,
  in merge queue, merged, escalated, skipped, cancelled. Includes what it waits for.
- **Attempt**: One Rovara conversation for a node. Conversation and task ids, base commit, plan
  decision, check reports, questions with their answers and answering model, pull request, fix and
  update counts, outcome, cost.
- **Event**: A signed message from Rovara, kept as received, with the attempt it belongs to.
- **Trace step**: One step of an attempt's agent trace: time, kind (message, reasoning, tool call,
  tool result, check, model retry or failure, status), and its text or input and output as Rovara
  recorded them. Ordered by Rovara's sequence number within the attempt.
- **Decision record**: Any automatic or human decision: actor, action, reason, run, node, attempt,
  time.
- **Repository health**: Whether main's required checks are passing, and whether dispatch is paused
  because of it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A DAG of at least 6 nodes, imported and started by one operator command each, runs to
  completion with no further human action, every pull request merged in dependency order.
- **SC-002**: Across all test runs, no node starts before every node it depends on has merged (zero
  violations in the decision records).
- **SC-003**: 95% of nodes start within 60 seconds of becoming eligible, when capacity is free.
- **SC-004**: With duplicate, delayed and dropped events injected, and the orchestrator restarted at
  random points, no run creates a second conversation for the same attempt, a second pull request
  for the same attempt, or a second merge.
- **SC-005**: After main is made red, no node starts and no pull request merges until it is green
  again.
- **SC-006**: One escalated node never stops an unrelated branch of the DAG from merging.
- **SC-007**: A load test reaches 1000 concurrent nodes in one run, with no node lost or started
  twice.
- **SC-008**: An operator can find the state, Rovara task and pull request of any node in under 30
  seconds.
- **SC-009**: For 95% of agent steps, the step appears on the node's page within 10 seconds of Rovara
  recording it, with 1000 nodes running.
- **SC-010**: Every attempt's trace is complete on its node's page after the run ends: every step
  Rovara recorded is shown, none twice.

## Assumptions

- The DAG comes from `speckit-dag --unit story --strict` (github.com/ps06756/speckit-dag). Building
  or editing DAGs is out of scope; a changed spec is a new import and a new run.
- One monorepo per run, with GitHub's merge queue turned on for main and required checks set.
  Several runs may target the same monorepo.
- The spec folders live in the monorepo, so a Rovara workspace can read them at the DAG's commit.
- Rovara does the coding, planning inside a node and its own checks; the orchestrator does not judge
  code quality beyond the merge conditions in FR-040.
- The orchestrator approves Rovara's plans itself (decided 2026-11-10).
- Retry defaults, until tuned: 2 fix requests per attempt, 3 attempts per node, 3 pull request
  updates per node, 3 review rounds per node, quiet timeout 30 minutes.
- The monorepo has an AI review tool (CodeRabbit or similar) that reviews every pull request,
  re-reviews new commits, and can be asked for a review again. Main's protection rules require CI
  checks and the merge queue, and do not require a person's approval, so the orchestrator's App can
  merge unattended.
- Cost comes from Rovara's per-task usage records; there is no separate billing source.
- Run, node, attempt, event and decision records are kept for at least 90 days after a run ends.
  Stored DAGs are kept until an operator deletes them.
- There is one operator role. Every operator (FR-054) can do every operator action, including
  taking over another operator's run.
- Every operator has linked their Rovara sign-in to the orchestrator's channel, as Rovara requires
  of anyone a channel adapter acts for (Rovara spec 062, FR-030).
- The orchestrator has one Slack notification channel, set when it is installed; its Slack app can
  post and reply in threads there.
- Out of scope: building or editing DAGs; runs across more than one repository; nodes smaller
  than a phase (`unit: task`); changing a DAG while it runs; deploying merged code. Merging to main
  is the end of a node.

## Dependencies

Work outside this repository that this feature needs. Statuses as of 2026-11-11.

| ID | Where | What | Needed for | Status |
|---|---|---|---|---|
| D1 | Rovara | Project-level workspace limits, settable through Rovara's admin settings | US6, FR-061 | Requested: PrepLabsAI/Rovara#430 |
| D2 | Rovara | A way for an adapter to read a conversation's current state (the channel API has only `POST` routes today) | FR-034, US3 | Filed: PrepLabsAI/Rovara#437 |
| D3 | Rovara | Typed fields on events: Rovara task id; pull request number and head commit on `pr`; outcome on `done` | FR-025, FR-040 | Filed: PrepLabsAI/Rovara#438 |
| D4 | Rovara | Closing a conversation's workspace and cancelling its task as typed actions for adapters, not chat text | FR-026, FR-050 | Filed: PrepLabsAI/Rovara#439 |
| D5 | Rovara | Per-adapter limits on new conversations per hour and open workspaces (spec 062's abuse cases) high enough for this use | US6 | Filed: PrepLabsAI/Rovara#440 |
| D6 | Rovara | Constitution principle VI says "a person merges pull requests". The orchestrator merges outside Rovara, through its own GitHub App, so Rovara itself still has no merge path; Rovara's maintainers should confirm this reading or amend the principle | FR-041 | Asked: PrepLabsAI/Rovara#443 |
| D7 | Rovara | Spec 062 is built through Phase 7a (rich messages, actions and adapter commands, merged 2026-11-11). The command-line tools for adding and binding an adapter are still in review (PrepLabsAI/Rovara#428), so for now the adapter is registered through Rovara's admin interface, which must first be turned on in the Rovara deployment | FR-020 | In progress |
| D8 | speckit-dag | `--unit story`, full task text and spec location, content hash, dirty and pushed checks | US1 | Done (`5a410b5`) |
| D9 | Monorepo | An AI review tool installed and configured; main's protection rules set to require CI and the merge queue but no human approval; the orchestrator's GitHub App allowed to merge | FR-040, FR-041, FR-045 | Not set up |
| D10 | Rovara | Streaming an attempt's agent trace to the adapter. Rovara's worker already records each finished agent step (messages, tool calls with input and result, checks, retries), with credentials removed, and sends them to the control plane within about 5 seconds. But only Rovara's own task page, Slack and the developer task API read them back, as one-line summaries (300 characters, newest 200), and adapters get only the conversation's own replies. Needed: the full recorded steps sent to a registered adapter as they arrive, plus a way to read them from a position onward to fill gaps. Can share one design with D2 | FR-055, US5 | Filed: PrepLabsAI/Rovara#441 |
| D11 | Rovara | Signing operators in to a separate service. Rovara's sign-in server issues signed tokens addressed to Rovara itself, and Rovara checks them with the server's published keys; the orchestrator must not accept tokens addressed to Rovara. Needed: Rovara's sign-in issuing tokens addressed to the orchestrator, from a terminal and from a browser, and a way for the orchestrator to ask whether a person is a Rovara administrator or has access to the monorepo's project | FR-054, FR-056, FR-057 | Filed: PrepLabsAI/Rovara#442 |
