# Quickstart: validating the DAG Orchestrator

How to prove the feature works, from local tests to a full run against Rovara. Interfaces are in
[contracts/](contracts/), entities and states in [data-model.md](data-model.md). Each scenario names
the spec items it proves.

## Prerequisites

- Node.js 22.19 or later, npm 10, Docker (for DynamoDB Local).
- For the TEST stage: an AWS account with the Rovara TEST install, its channel adapters turned on,
  and Bedrock access to `anthropic.claude-opus-5-5` in the region.
- A test monorepo set up as in [contracts/github-app.md](contracts/github-app.md#repository-settings-required-d9):
  merge queue on main, required CI, the AI review tool, no required human approval.
- `speckit-dag` installed (`pip install -e '.[yaml]'` in `ps06756/speckit-dag`).

## 1. Local: unit, property and fault tests

```bash
npm ci
npm test                 # unit + property tests of the core (state machines, scheduler, merge gate)
npm run test:contract    # pinned Rovara schemas vs Rovara mainline at the pinned commit (R4)
npm run test:fault       # whole DAGs against fakes on DynamoDB Local, with injected faults
```

Expected:
- Property tests pass for 10,000 random DAGs: no node starts before its dependencies merge, no two
  running nodes share a file, capacity is never exceeded (SC-002, FR-022).
- The fault suite stops and restarts the process at every intent boundary, and duplicates, delays,
  drops and reorders every fake's deliveries. Every run completes with exactly one conversation per
  attempt, one PR per attempt and one merge per node (SC-004).
- Main made red in the fakes: no start and no merge until green (SC-005).
- One node failing every time: it escalates, its dependent waits, an unrelated node merges (SC-006).

## 2. Local: import

```bash
speckit-dag specs/001-user-auth --unit story --strict > units.json   # in the test monorepo
rovara-orch --url http://localhost:3000 dag import units.json         # local API against fakes
rovara-orch dag import units.json                                     # again: same dag-id, "not new"
```

Then edit one task's text, commit and push, rebuild and import: a new dag-id. With an uncommitted
change in the spec folder, `speckit-dag --strict` fails; a hand-edited file with `spec.dirty: true`
is refused with `spec_dirty` (US1 scenarios 1 to 5).

## 3. TEST stage: a 6-node run end to end

```bash
npm run deploy -- --stage test           # prints the API URL and the status page URL
VITE_API_URL=<api url> npm run -w packages/web build
npm run deploy -- --stage test           # again: uploads the built status page
rovara-orch login                         # Rovara sign-in (development identity until Rovara#442)
rovara-orch dag import units-6node.json   # Setup -> Foundational -> US1, US2, US3 -> Polish
rovara-orch run start <dagId> --concurrency 3 --cost-limit 50
```

Expected (US2, SC-001):
- Setup, then Foundational, start alone; US1, US2 and US3 start after Foundational's merge, from
  main at or after that merge; Polish starts after all three.
- Each node: plan approved by the orchestrator, checks pass, PR opened, review tool comments
  addressed, CI green, merged through the queue, workspace close requested.
- The status page shows each node's PRs and trace; new steps appear within 10 seconds
  (SC-009; full trace once Rovara#441 lands).
- `rovara-orch run status <runId>` ends `complete`; the run's decision records list every
  approval, answer and merge.

Restart check: during the run, redeploy the worker functions. The run completes with no duplicate
conversation or PR (US2 independent test).

Stop check: while US1 to US3 run, `rovara-orch stop on --reason test`. Nothing starts, no plan is
approved and nothing merges; `rovara-orch stop off --reason test` resumes, and the run completes.
`rovara-orch run pause` and `run resume` behave the same for one run (Constitution VI).

## 4. TEST stage: failure paths

- Force a node's checks to fail (a test that always fails): fix requests, then new attempts, then
  escalation. A Slack message appears in the notification channel; `rovara-orch node retry`
  after a fix posts the thread reply and the run completes (US3).
- Make two parallel nodes list the same file: they do not run at once; `run status` shows
  `waitingFor: files` (US4 scenario 1).
- Push a breaking commit to main: the repository pauses, a Slack message names the failing
  checks, and nothing starts or merges until it is fixed (US4 scenario 3).
- `rovara-orch stop on --reason test`: no starts, approvals or merges anywhere (US5 scenario 4).
- `rovara-orch run cancel <runId> --reason test`: running tasks stopped, workspaces closed, open PRs
  closed (US5 scenario 3).

## 5. Load stage: 1000 concurrent nodes

```bash
npm run deploy -- --stage load      # orchestrator + fake Rovara and fake GitHub as Lambdas
npm run load -- --nodes 1200 --concurrency 1000
```

Expected (US6, SC-003, SC-007, SC-009): concurrency reaches 1000; 95% of eligible nodes start
within 60 seconds of capacity; no node lost or started twice; workspace-limit refusals return nodes
to waiting without using attempts; 95% of trace steps visible within 10 seconds.
