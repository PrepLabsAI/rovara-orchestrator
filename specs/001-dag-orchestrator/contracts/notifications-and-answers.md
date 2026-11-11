# Contract: Slack notifications and the answering model

## Slack notifications (FR-035)

A Slack app with the `chat:write` scope, invited to the one configured channel. Token in the
secret store.

| Cause | First message (chat.postMessage) | Thread reply when resolved |
|---|---|---|
| Node escalated | ":rotating_light: <run> / <node> escalated: <reason>." Links: run, node, Rovara task, PR | "Retried / skipped / cancelled by <operator>: <reason>." |
| Repository paused (main red) | ":octagonal_sign: <repo> main is failing <checks> at <commit>. Dispatch and merges paused for <n> runs." | "main is green again at <commit>; resumed." |
| Run at cost limit | ":moneybag: <run> reached its cost limit of $<limit>. No new nodes start." | "<operator> raised the limit / resumed / cancelled." |
| Administrator request | ":lock: <run> / <node>: Rovara asks for an administrator's confirmation." | as for escalation |
| Acting-for operator lost access | ":bust_in_silhouette: <run> paused: Rovara no longer accepts work for <operator>." | "Taken over by <operator>." |

Each first message's `ts` is stored on its intent and on the node, run or repository it is about,
so a thread reply always finds it. A failed post is retried, and the notification shows on the
run's status page until it is delivered.

## Answering model (FR-027)

Claude Opus 5.5 on Amazon Bedrock (`anthropic.claude-opus-5-5`, configurable), through the
Anthropic TypeScript SDK's Bedrock Mantle client (R8).

**Request**

- `system`: fixed instructions. You answer a coding agent's question about the task it is doing.
  Answer from the spec documents and tasks given. Choose the simplest option that meets the spec.
  When the spec does not decide, say which assumption you made, so it can be listed in the pull
  request. Never ask a question back.
- First user content block: the spec folder's documents and the node's tasks at the DAG's commit,
  with a prompt-cache breakpoint after it (the same for every question in the DAG).
- Second block: the question, and its choices if Rovara offered any.
- `thinking: { type: "adaptive" }`, `output_config: { effort: "high", format: <schema below> }`,
  streaming, `finalMessage()`.

**Response schema** (structured output):

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["answer", "confidence", "citations"],
  "properties": {
    "answer": { "type": "string", "minLength": 1, "maxLength": 4000 },
    "choice": { "type": ["string", "null"] },
    "confidence": { "type": "string", "enum": ["high", "medium", "low"] },
    "citations": { "type": "array", "items": { "type": "string" } }
  }
}
```

`answer` is sent to Rovara unchanged. When Rovara offered choices, `choice` must be one of them, or
the answer is sent without it. `confidence` and `citations` are recorded and shown on the status
page, never acted on: the spec says a question is never escalated.

**Failure handling**: check `stop_reason` before reading content. On a refusal, the SDK's
client-side refusal fallback middleware retries on its fallback model (Bedrock has no server-side
fallbacks). On a refusal after that, an API error after 3 tries, or a response that does not parse,
send the fixed reply: "Follow the spec; choose the simplest option that meets it, and list the
choice in the PR description."
