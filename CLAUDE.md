# Rovara Orchestrator: working guide

Runs a speckit-dag DAG on one monorepo through Rovara, and merges through its own GitHub App. The
spec, plan and task list are in `specs/001-dag-orchestrator/`; the constitution is
`.specify/memory/constitution.md` and overrides everything here.

## The seven principles, in one line each

1. **Thin orchestrator**: schedule, supervise, merge, clean up. Never plan, write product code or edit DAGs.
2. **Immutable DAGs**: a stored DAG never changes; a changed spec is a new import and a new run.
3. **Exactly-once effects**: store every decision before acting; every outside effect (including
   queueing an input) is an intent written in the same transaction and carried out idempotently.
4. **Rovara through its contracts**: only the channel adapter API, sign-in and admin settings; never
   read reply wording; every Rovara action is made for a named operator.
5. **Gated merges**: own App, merge queue, all merge-gate conditions in `canMerge`; a red main stops the line.
6. **Unattended but attributable**: no person on the normal path; every decision recorded; the stop
   switch always works.
7. **Proven against failure**: test first, against fakes that inject duplicate, delayed, dropped and
   reordered deliveries and restarts.

## Test first

Write the test, watch it fail, then write the code. A change that adds behaviour without a test
that failed first is sent back.

## Package map

| Package | Holds |
|---|---|
| `core` | pure domain: model, ids, the attempt, run and repository machines, scheduler `pick`, merge gate, texts. No I/O |
| `store` | DynamoDB keys, transactions with version checks, `applyTransition`, item access |
| `dag-import` | speckit-dag validation, hash, import |
| `rovara` | channel adapter client, Standard Webhooks signing, pinned contract copies |
| `github` | GitHub App client, webhook verification, merge queue, review threads |
| `slack` | notification texts and posting |
| `answerer` | Claude Opus 5.5 on Bedrock for the agent's questions |
| `identity` | operator identity (development-only implementation until Rovara#442) |
| `api` | operator API routes |
| `workers` | Lambda entry points: ingresses, work consumer, intent runner, scheduler, sweep, effect executors |
| `cli` | `rovara-orch` |
| `web` | read-only status page |
| `testkit` | fakes with fault injection, DynamoDB Local helpers, the in-process harness |

## Commands

```bash
npm run db:up          # DynamoDB Local (needed by store, integration and fault tests)
npm test               # unit + infra
npm run test:contract
npm run test:integration
npm run test:fault
npm run lint && npm run typecheck
```

## Rules of thumb

- Imports between files use `.js` extensions (NodeNext); packages import each other as `@rovara-orch/<name>`.
- Nothing sends to the queue directly except the sweep; everything else writes an enqueue intent.
- Stories own their files. Shared extension points (handlers, gates, routes, commands, executors)
  were created as stubs in the Foundational phase; fill in your story's files, not another's.
