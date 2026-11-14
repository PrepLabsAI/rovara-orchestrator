# Rovara Orchestrator

Runs a whole feature's worth of coding work on one monorepo, unattended, through an existing
Rovara deployment.

You give it a dependency graph of work: one node per phase or user story, produced from a spec's
`tasks.md` by [speckit-dag](https://github.com/ps06756/speckit-dag). For every node whose
dependencies have merged, it:

1. starts a Rovara task;
2. approves the plan;
3. answers the agent's questions from the spec;
4. sends failed checks back for a fix;
5. has every AI review comment addressed;
6. merges the PR through GitHub's merge queue with its own GitHub App;
7. closes the workspace.

You watch it on a status page and step in only when a node is escalated.

It is a separate product. It talks to Rovara only through Rovara's public channel adapter API, so
it works with any Rovara deployment that has channel adapters turned on.

```
            you ──CLI / API──▶  Orchestrator  ◀──webhooks── GitHub (your monorepo)
                                 │      ▲
          signed messages, for a │      │ signed events
              named person       ▼      │ (task started, PR opened, checks…)
                                 Rovara (deployed somewhere)
```

## Contents

- [What you need](#what-you-need)
- [Limits today](#limits-today)
- [Try it locally first](#try-it-locally-first)
- [Install](#install)
- [Use it](#use-it)
- [Who it acts as](#who-it-acts-as)
- [How it works](#how-it-works)
- [Develop](#develop)

## What you need

| | Requirement |
|---|---|
| **Rovara** | A deployment with channel adapters on (control-plane parameter `ChannelAdapters=enabled`), and a Rovara administrator of the monorepo's project to register the adapter |
| **AWS** | An account and region with Claude Opus 5.5 enabled in Bedrock. Everything runs serverless: API Gateway, Lambda, DynamoDB, SQS, S3 and CloudFront |
| **GitHub** | The monorepo, with a merge queue on `main`, required CI checks and an AI review tool (CodeRabbit by default). You create a GitHub App for the orchestrator |
| **Slack** (optional) | A bot token and a channel for escalations. Without it, notifications wait on the status page |
| **Your machine** | Node 22.19 or later; Docker for local runs and tests |

## Limits today

- **Sign-in is development-only.** Operators sign in with tokens signed by the deployment's own
  secret (`scripts/dev-token.ts`). Real sign-in needs Rovara#442, or tokens signed by Rovara Cloud.
  Until then, deploy the `test` stage. The `prod` stage refuses development sign-in.
- **Rovara's legacy production deployment can't host adapters yet.** That's tracked in Rovara#487
  and Rovara#507. A named Rovara environment with `ChannelAdapters=enabled` works today.

## Try it locally first

No AWS, Rovara or GitHub needed. This runs the orchestrator against fake Rovara and GitHub
services on your machine, with a six-node sample run:

```bash
npm ci
npm run db:up                                  # DynamoDB Local in Docker
npm run -w packages/web build                  # the status page
npm run local -- --demo --pace 800 --port 3200
```

Open http://localhost:3200/ and watch the six nodes start, open PRs and merge in
dependency order.

## Install

The [runbook](docs/runbook.md) has every command in full; this is the order.

### 1. Deploy

```bash
npm ci
cd infra && npx cdk bootstrap && cd ..          # once per AWS account and region
npm run deploy -- -c stage=test \
  -c 'rovara={"url":"https://<rovara api>","channel":"orchestrator","tenant":"<company>","space":"<monorepo>"}' \
  -c 'github={"appId":"0","installationId":"0"}' \
  -c 'devOperators=[{"id":"alice","name":"Alice","admin":true}]'
```

- **`tenant` and `space`** are names you choose: `tenant` for your company or this install (for
  example `acme`), `space` for the monorepo (for example `acme-mono`).
- **`github` ids:** use `"0"` on the first deploy; the GitHub App comes in step 3.
- **Output:** the deploy prints `ApiUrl` and `StatusPageUrl`. It creates four empty secrets, which
  the next steps fill in. Until then the functions refuse every request.

### 2. Register the orchestrator with Rovara

A Rovara administrator runs:

```bash
agentx --env <rovara env> adapter add orchestrator \
  --callback-url <ApiUrl>/rovara/events \
  --projects <the monorepo's Rovara project> \
  --step-up admin \
  --secret-file ./adapter-secret
agentx --env <rovara env> adapter bind orchestrator --tenant <company> --space <monorepo> --project <project>
```

Then store the secret Rovara wrote and delete the file:

```bash
aws secretsmanager put-secret-value --secret-id rovara-orch/test/rovara-adapter-secret --secret-string file://adapter-secret
rm adapter-secret
```

`--step-up admin` matters. With Rovara's default, plan approvals need a person on the task page,
and the orchestrator would escalate every node.

### 3. Create the GitHub App

1. Create it from [`infra/github-app-manifest.json`](infra/github-app-manifest.json), with the
   webhook URL `<ApiUrl>/github/events`.
2. Install it on the monorepo only.
3. Store its private key and webhook secret in `rovara-orch/test/github-app-private-key` and
   `rovara-orch/test/github-webhook-secret`.
4. Deploy again with the real `appId` and `installationId`.

On the monorepo, let the App merge through the merge queue, and require no human approval.

### 4. Slack (optional)

Store the bot token in `rovara-orch/test/slack-token`, and set the notification channel on the
settings item ([runbook, section 4](docs/runbook.md#4-slack-and-settings)). If your review tool
isn't CodeRabbit, set its login there too.

### 5. Sign in and check

```bash
npm link -w packages/cli                       # puts rovara-orch on your PATH
npx tsx scripts/dev-token.ts --stage test --operator alice
rovara-orch --url <ApiUrl> login --token <token>
rovara-orch whoami
```

## Use it

### Make the graph

In the monorepo, write the spec and its tasks with speckit (`/speckit-specify`, `/speckit-plan`,
`/speckit-tasks`), commit and push them, then build the graph:

```bash
speckit-dag specs/014-billing --unit story --strict -o units.json
```

The orchestrator refuses a graph built from uncommitted or unpushed files, so the graph always
matches what's on GitHub.

### Run it

```bash
rovara-orch dag import units.json
rovara-orch run start <dagId> --concurrency 3 --cost-limit 50
```

The first time, Rovara asks you to link your account. `run start` prints the link: sign in to
Rovara, confirm, and run the command again. It prints the run's status page link.

### Day to day

| Command | Does |
|---|---|
| `rovara-orch run status <runId>` | Counts, cost, and which nodes wait on what |
| `rovara-orch node show <runId> <nodeId>` | One node's attempts, PRs, checks, questions and decisions |
| `rovara-orch run pause\|resume\|cancel <runId> --reason "…"` | Control one run |
| `rovara-orch run take-over <runId> --reason "…"` | Act for yourself instead of the person who started the run |
| `rovara-orch node retry\|skip <runId> <nodeId> --reason "…"` | Deal with an escalated node |
| `rovara-orch stop on\|off --reason "…"` | Stop every start, approval and merge at once. Agents keep working; nothing merges |

Everything the CLI does goes through the operator API (`<ApiUrl>/v1/…`), which other tools can
call with the same token. The routes are listed in
[`contracts/operator-api.md`](specs/001-dag-orchestrator/contracts/operator-api.md).

### When it stops by itself

| What happened | What it does |
|---|---|
| A node fails three attempts | Escalates it, posts to Slack, and keeps going with nodes that don't depend on it |
| `main` turns red | Starts and merges nothing new until `main` is green again |
| The cost limit is reached | Pauses the run |
| The person it acts for loses Rovara access | Pauses the run until someone takes it over |

## Who it acts as

Every request to Rovara carries two identities:

- **The adapter:** the request is signed with the adapter secret, so Rovara knows it comes from the
  registered orchestrator.
- **The person:** the request names the operator who started the run (or took it over). That
  person linked their Rovara account to the `orchestrator` channel once.

Rovara does the work as that person: with their permissions, under their workspace limit, and in
their name in Rovara's audit log. Plans the orchestrator approves are recorded as theirs, made
through the orchestrator. Removing the link stops it at once.

## How it works

- **Thin.** It schedules, supervises, merges and cleans up. It never plans, writes product code or
  edits a graph; Rovara's agents do the work.
- **Exactly once.** Every decision is stored before it's acted on. Every outside effect (a message
  to Rovara, a merge, a PR close) is recorded in the same transaction and carried out
  idempotently, so restarts and repeated webhooks never double anything.
- **Gated merges.** It merges only through the merge queue, only when checks are green, review is
  resolved and `main` is green.
- **File locks.** Two nodes that touch the same file never run at once.

The specification, plan and design are in [`specs/001-dag-orchestrator/`](specs/001-dag-orchestrator/).
The rules every change follows are in [`.specify/memory/constitution.md`](.specify/memory/constitution.md).
Operations (alarms, secret rotation, recovery) are in the [runbook](docs/runbook.md).

## Develop

```bash
npm ci
npm run db:up            # DynamoDB Local on port 8000
npm test                 # unit and infrastructure tests
npm run test:contract    # Rovara schemas, GitHub payloads, speckit-dag fixtures
npm run test:integration # packages wired together on DynamoDB Local
npm run test:fault       # whole graphs with injected faults and restarts
npm run lint && npm run typecheck
```

[`CLAUDE.md`](CLAUDE.md) has the package map and the working rules.
