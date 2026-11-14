# Contract: Rovara channel adapter

How the orchestrator uses Rovara's channel adapter API (Rovara spec 062), as of Rovara `mainline`
`c35d5967`. Shapes are Rovara's (`packages/contracts/src/channel-adapter.ts`, `conversation.ts`);
the orchestrator keeps pinned copies checked by a contract test (R4).

## Registration (once per install)

Registered by a Rovara administrator (D7):

```json
{
  "callbackUrl": "https://<orchestrator>/rovara/events",
  "capabilities": { "threads": true, "buttons": 4, "edits": false, "maxTextLength": 100000, "proactive": true },
  "projects": ["<monorepo project>"],
  "stepUp": []
}
```

`stepUp: []` lets the orchestrator decide plan approvals (FR-020, FR-023). The signing secret
returned once goes to the secret store. One space is bound: `{ channel: "orchestrator",
tenant: "<install>", space: "<repo-slug>" }` to the monorepo's project.

## Identifiers

- Conversation: `{ channel: "orchestrator", tenant, space, thread: "<runId>.<nodeId>.a<n>" }`, one
  per attempt (FR-021).
- Actor: `{ channel: "orchestrator", tenant, userId: <operator's Rovara developer id> }`, the run's
  `actingFor` operator (FR-057), who must have linked their sign-in (Rovara FR-030).
- `eventId` on everything we send: `<attemptId>.<intentSeq>`, so Rovara drops a repeat.

## What the orchestrator sends

Signed with Standard Webhooks headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`)
using the adapter secret.

| When | Route | Body |
|---|---|---|
| Attempt starts | `POST /v1/channels/orchestrator/messages` | `InboundMessage` v2; `text` = the node brief below |
| Plan approval requested | `POST /v1/channels/orchestrator/decisions` | `ChannelDecision` v1 with `decision: "APPROVE"`, echoing `requestId`, `expectedRevision`, `artifactDigest`; `reason` names the run and node |
| Admin approval requested | none | the node is escalated (Edge Cases) |
| Rovara asks a question | `messages` | the answering model's answer, unchanged (FR-027) |
| Checks passed, no PR yet | `messages` | "Checks passed. Create the pull request." (FR-024) |
| Checks failed | `messages` | the failing checks from the report, asking for a fix (FR-031) |
| Review comments | `messages` | each unresolved comment with its file, line and link, asking to fix each with a commit or reply with a reason (FR-045) |
| Conflict or out of date | `messages` | asks Rovara to update the pull request from main and resolve conflicts (FR-042) |
| Merged or abandoned | `messages` | `close this workspace` until #439 lands; then the typed close (FR-026) |
| Cancel | `messages` | `stop` until #439 lands; then the typed cancel (FR-050) |

**Node brief** (first message): the node title and kind; every task's full text in order; the spec
folder path and its document paths at the DAG's commit; the base commit; and the instruction to
implement the tasks in order, keep to the listed files where possible, run the project's checks,
and not open a pull request until asked.

## What the orchestrator receives

At `POST /rovara/events`. Verified: signature with the adapter secret, timestamp within 5 minutes,
`channel == "orchestrator"`; repeats dropped by `id` (FR-025). The conversation's `thread` names the
attempt; an event for an attempt that is not current is stored but changes nothing.

| Event | Orchestrator does |
|---|---|
| `ack` | attempt `starting` -> `planning` |
| `approval_request` (`plan_approval`) | records `taskUrl` as the node's Rovara task link; posts `APPROVE`, held until the stop switch is off (FR-051) |
| `approval_request` (`admin`) | escalates |
| `approval_request` (`other`) | escalates (an unknown confirmation is not guessed) |
| `question` | asks the answering model, replies (FR-027) |
| `check_report` `passed` | asks for the PR if none |
| `check_report` `failed` / `unknown` | sends a fix request while fix requests remain; else a new attempt, or escalates |
| `pr` | records the PR (number from the URL, head and state from GitHub until #438); moves to review |
| `progress`, `message` | stored as trace steps (R10) |
| `done` | recorded; attempt outcome is decided from checks, PR and GitHub, not from `done` text |
| `error` | `workspace_limit`: back to waiting, no attempt used (FR-062); throttling: counts toward back-off (R6); other: new attempt or escalate |
| `link_required` | pauses the run and notifies; the operator must link (FR-057) |
| `trace` (once #441 lands) | stored as trace steps |

## Pending Rovara changes

| Issue | Changes here when it lands |
|---|---|
| #437 state read | quiet attempts are checked, not escalated (FR-034) |
| #438 typed fields | PR number, head and outcome come from the event |
| #439 typed close/cancel | close and cancel confirmed by typed events |
| #440 adapter limits | per-adapter limits set to match run concurrency |
| #441 trace stream | full trace, and per-task usage for the cost total |
| #442 sign-in | operator tokens and access check (operator-api.md) |
