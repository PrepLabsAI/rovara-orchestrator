# Runbook: Rovara orchestrator

How to deploy and run the orchestrator, and what to do when an alarm fires. Read the spec's
dependency table (`specs/001-dag-orchestrator/spec.md`, "Dependencies") first: several steps
change when the Rovara issues it lists land.

## Stages

| Stage | Use | Notes |
|---|---|---|
| `test` | End-to-end runs against Rovara TEST and the test monorepo (quickstart section 3) | development sign-in |
| `load` | Load tests against the fake Rovara and GitHub (`tests/load`) | the only stage with the fakes |
| `prod` | Real runs | refuses the development sign-in, so it cannot run until Rovara#442 |

## 1. Deploy

You need AWS credentials for the target account, in a region where Claude Opus 5.5 is enabled in
Bedrock, and Node 22.19 or later.

```bash
npm ci
npx cdk bootstrap                         # once per account and region (run in infra/)
npm run deploy -- -c stage=test \
  -c 'rovara={"url":"https://<rovara-test>","channel":"orchestrator","tenant":"<tenant>","space":"<space>"}' \
  -c 'github={"appId":"<app id>","installationId":"<installation id>"}' \
  -c 'devOperators=[{"id":"dev_alice","name":"Alice","admin":true}]'
```

The deploy prints `ApiUrl`, `TableName`, `WorkConsumerLogGroup` and `StatusPageUrl`. The first
deploy creates the four secrets empty; the functions fail until steps 2 to 4 fill them.

Then build the status page against the API and deploy again to upload it:

```bash
VITE_API_URL=<ApiUrl> npm run -w packages/web build
npm run deploy -- -c stage=test …          # same context as above
```

## 2. Register the Rovara adapter (D7)

Until Rovara's adapter commands land (PrepLabsAI/Rovara#428), register the orchestrator through
Rovara's admin interface, which must be turned on in the Rovara deployment:

1. Add a channel adapter named `orchestrator`, with the callback URL `<ApiUrl>/rovara/events`.
   Register it **without step-up**: an adapter registered with step-up gets plan approvals with no
   approve actions, and the orchestrator escalates every such node.
2. Bind it to the monorepo's Rovara project and space.
3. Store the signing secret Rovara returns:

```bash
aws secretsmanager put-secret-value --secret-id rovara-orch/test/rovara-adapter-secret --secret-string '<whsec_…>'
```

Each operator who will start runs must link their Rovara sign-in to the `orchestrator` channel
(Rovara sends a `link_required` link the first time; `rovara-orch run start` prints it).

## 3. Create the GitHub App and set up the monorepo (D9)

1. Create the App from `infra/github-app-manifest.json` (GitHub's "register a GitHub App from a
   manifest" flow), with the webhook URL set to `<ApiUrl>/github/events`. The manifest asks for
   exactly the permissions in `contracts/github-app.md`; a test checks that it still does.
2. Install it on the monorepo only. Note the App id and installation id for the deploy context.
3. Store its private key and webhook secret:

```bash
aws secretsmanager put-secret-value --secret-id rovara-orch/test/github-app-private-key --secret-string file://app.private-key.pem
aws secretsmanager put-secret-value --secret-id rovara-orch/test/github-webhook-secret --secret-string '<webhook secret>'
```

4. On the monorepo: turn on the merge queue for `main`; require the CI checks; require no human
   approval; allow the App to merge through the queue; install the AI review tool so it reviews
   every PR and every new commit. If the review tool is not CodeRabbit, change `reviewToolLogin`
   and `reRequestComment` (section 4).

## 4. Slack and settings

Create a Slack app with the `chat:write` and `channels:history` scopes, invite it to the
notification channel, and store its bot token:

```bash
aws secretsmanager put-secret-value --secret-id rovara-orch/test/slack-token --secret-string 'xoxb-…'
```

Settings have no API route yet. Set the notification channel (and, if needed, the review tool) on
the settings item:

```bash
aws dynamodb update-item --table-name <TableName> \
  --key '{"pk":{"S":"SETTINGS"},"sk":{"S":"GLOBAL"}}' \
  --update-expression 'SET notificationChannel = :c, entityType = :e, version = if_not_exists(version, :z) + :one' \
  --expression-attribute-values '{":c":{"S":"C0123456789"},":e":{"S":"SETTINGS"},":z":{"N":"0"},":one":{"N":"1"}}'
```

Until a notification is delivered it stays pending, is retried every 30 minutes at most, and shows
on the run's status page as not delivered.

## 5. Sign in and run

```bash
npx tsx scripts/dev-token.ts --stage test --operator dev_alice   # until Rovara#442
rovara-orch --url <ApiUrl> login --token <token>
rovara-orch dag import units.json
rovara-orch run start <dagId> --concurrency 3 --cost-limit 50
rovara-orch run status <runId>
```

## Rotating secrets

| Secret | How |
|---|---|
| Rovara adapter secret | Rotate it in Rovara's admin interface, then `put-secret-value`. Development tokens are signed with it, so mint new ones. Events signed with the old secret during the switch are refused with 401 and retried by Rovara. |
| GitHub App private key | Generate a new key in the App's settings, `put-secret-value`, then delete the old key in GitHub. |
| GitHub webhook secret | Set the new secret in the App's settings and `put-secret-value` at once; deliveries refused in between can be redelivered from the App's "Recent deliveries" page. |
| Slack token | Reinstall the Slack app, `put-secret-value`. |

The functions cache secrets per container. To make every container read the new value at once,
redeploy, or update any function's configuration.

## The stop switch

`rovara-orch stop on --reason "<why>"` stops every start, plan approval and merge, for every run,
at once. Running agents keep working; nothing they finish is merged. `rovara-orch stop off --reason
"<why>"` releases held approvals and merges. Use it first when anything looks wrong; it never
loses work. To stop one run instead: `rovara-orch run pause <runId> --reason "<why>"`.

## Alarms

All alarms notify the SNS topic `rovara-orch-<stage>-alarms`; subscribe the on-call address to it.
The dashboard is `rovara-orch-<stage>-dashboard`.

| Alarm | Meaning | Do |
|---|---|---|
| `dlq-depth` | An input failed five times in the work consumer | Read the message on the dead-letter queue and the consumer's log for its `inputId`. Fix the cause, then move the message back to the work queue (SQS "start DLQ redrive"). Inputs are processed exactly once, so a redrive is safe. |
| `failed-intents` | An outside effect (a Rovara message, a merge, a PR close) failed after its last try; the attempt that owns it was told, and usually escalated | See "Recovering failed intents". |
| `ingress-5xx` | The ingresses or the API answered 5xx | Rovara and GitHub retry, so nothing is lost while it lasts. Read the function's log. |
| `consumer-errors` | The work consumer threw | Usually a version conflict storm or an outside read failing. Read the log. |
| `scheduler-stalled` | No scheduling pass for 3 minutes while runs are active | Check the sweep function runs every minute and that the work consumer is not failing. Nothing new starts until it recovers. |

## Recovering failed intents

A failed intent keeps its error. Find them:

```bash
aws dynamodb scan --table-name <TableName> --filter-expression '#s = :f' \
  --expression-attribute-names '{"#s":"status","#k":"key"}' --expression-attribute-values '{":f":{"S":"failed"}}' \
  --projection-expression 'pk, sk, effect, #k, lastError, tries'
```

Fix the cause first (a secret, a permission, Rovara or GitHub being down). Then put the intent back
to pending; the sweep runs it within a minute. Executors are idempotent by the intent's key, so a
re-run never doubles an effect:

```bash
aws dynamodb update-item --table-name <TableName> --key '{"pk":{"S":"<pk>"},"sk":{"S":"<sk>"}}' \
  --update-expression 'SET #s = :p, tries = :z, nextTryAt = :now, gsi1pk = :g, gsi1sk = :gs' \
  --expression-attribute-names '{"#s":"status"}' \
  --expression-attribute-values '{":p":{"S":"pending"},":z":{"N":"0"},":now":{"S":"<ISO time>"},":g":{"S":"PENDING_INTENT"},":gs":{"S":"<ISO time>#<pk>#<sk>"}}'
```

If the node was escalated because of it, `rovara-orch node retry <runId> <nodeId> --reason "<why>"`
afterwards.
