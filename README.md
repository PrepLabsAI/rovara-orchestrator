# Rovara Orchestrator

Runs a DAG of work on one monorepo with Rovara. It imports a graph produced by
[speckit-dag](https://github.com/ps06756/speckit-dag) (`--unit story`), starts each unblocked node as a
Rovara conversation, approves the plan, answers the agent's questions, has every AI review comment
addressed, merges through GitHub's merge queue with its own GitHub App, and closes the workspace.

The specification, plan and tasks are in [`specs/001-dag-orchestrator/`](specs/001-dag-orchestrator/).

## Tests

```bash
npm ci
npm run db:up            # DynamoDB Local on port 8000
npm test                 # unit and infrastructure tests
npm run test:contract    # contract tests (Rovara schemas, GitHub payloads, speckit-dag fixtures)
npm run test:integration # packages wired together on DynamoDB Local
npm run test:fault       # whole DAGs with injected faults and restarts
```
