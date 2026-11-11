# Contract: Command line

Binary: `rovara-orch`. Every command calls the operator API ([operator-api.md](operator-api.md)).
Every command prints readable text by default and JSON with `--json`. Exit codes: `0` success,
`1` refused or invalid, `2` usage error, `3` cannot reach the orchestrator or Rovara.

Global options: `--url <orchestrator url>` (or `ROVARA_ORCH_URL`), `--json`.

| Command | Does |
|---|---|
| `rovara-orch login` | Signs in with Rovara through the terminal flow; stores the token in the OS keychain (R9) |
| `rovara-orch logout` | Removes the stored token |
| `rovara-orch whoami` | Shows the signed-in operator and whether Rovara reports them as an administrator |
| `rovara-orch dag import <file>` | Imports a speckit-dag JSON file; prints the dag-id and whether it was new |
| `rovara-orch dag list` / `dag show <dagId>` | Lists or shows stored DAGs |
| `rovara-orch run start <dagId> --concurrency <n> --cost-limit <usd> [--attempts n] [--fix-requests n] [--pr-updates n] [--review-rounds n] [--quiet-minutes n]` | Starts a run; prints the run id and the status page link. If the operator is not linked, prints Rovara's link URL and exits 1 |
| `rovara-orch run list [--state s]` / `run status <runId>` | Lists runs, or shows one run's counts, cost and waiting nodes |
| `rovara-orch run pause\|resume\|cancel\|take-over <runId> --reason <text>` | Run controls (FR-050, FR-057) |
| `rovara-orch node show <runId> <nodeId>` | One node's attempts, PRs, questions, review comments and decisions |
| `rovara-orch node retry\|skip\|cancel <runId> <nodeId> --reason <text>` | Escalated-node actions (FR-033) |
| `rovara-orch stop on\|off --reason <text>` / `stop status` | Global stop switch (FR-051) |
| `rovara-orch repo status <owner/name>` | Repository pause state and capacity |
| `rovara-orch repo workspace-limit <owner/name> --open <n> --per-person <n>` | Requests a project workspace limit from Rovara (FR-061) |

`--reason` is required on every action that changes state, so that each decision record has one
(FR-054).

The command line never prints the agent trace: the constitution shows traces only on the status
page (FR-055). `node show` links to the node's page instead.
