# GitHub webhook fixtures

Payloads for the webhook events the orchestrator handles, trimmed from GitHub's documented examples
(https://docs.github.com/en/webhooks/webhook-events-and-payloads) to the fields the mappers read, for
the monorepo `acme/mono` and pull request #7. File names are `<event>.<action>[.<variant>].json`, and
the event name is the `X-GitHub-Event` header.
