import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, DynamoDBStreamEvent, SQSBatchResponse, SQSEvent } from "aws-lambda";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { QueueMessage } from "@rovara-orch/core";
import { handleGithubEvent } from "../ingress-github.js";
import { handleRovaraEvent } from "../ingress-rovara.js";
import { runIntent } from "../intent-runner.js";
import { runSweep } from "../sweep.js";
import { consume } from "../work-consumer.js";
import { runtimeDeps, secret } from "./runtime.js";

const body = (e: APIGatewayProxyEventV2) => (e.isBase64Encoded && e.body ? Buffer.from(e.body, "base64").toString("utf8") : (e.body ?? ""));

/** POST /rovara/events */
export async function rovaraIngress(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const r = await handleRovaraEvent(await runtimeDeps(), await secret("ROVARA_SECRET_ARN"), { headers: event.headers, body: body(event) });
  return { statusCode: r.status, body: r.body ?? "" };
}

/** POST /github/events */
export async function githubIngress(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const r = await handleGithubEvent(await runtimeDeps(), await secret("GITHUB_WEBHOOK_SECRET_ARN"), { headers: event.headers, body: body(event) });
  return { statusCode: r.status, body: r.body ?? "" };
}

/** SQS FIFO work queue. A failed message is reported so SQS redelivers only that one (and its group waits). */
export async function workConsumer(event: SQSEvent): Promise<SQSBatchResponse> {
  const deps = await runtimeDeps();
  const failures: SQSBatchResponse["batchItemFailures"] = [];
  let failedGroup = false;
  for (const record of event.Records) {
    if (failedGroup) {
      failures.push({ itemIdentifier: record.messageId });
      continue;
    }
    try {
      await consume(deps, JSON.parse(record.body) as QueueMessage);
    } catch (e) {
      deps.log?.({ event: "consume.failed", messageId: record.messageId, error: e instanceof Error ? e.message : String(e) });
      failures.push({ itemIdentifier: record.messageId });
      failedGroup = true; // keep FIFO order: later messages in the batch are retried after this one
    }
  }
  return { batchItemFailures: failures };
}

/** DynamoDB stream: run each new pending intent. */
export async function intentRunner(event: DynamoDBStreamEvent): Promise<void> {
  const deps = await runtimeDeps();
  for (const record of event.Records) {
    const image = record.dynamodb?.NewImage;
    if (!image) continue;
    const item = unmarshall(image as never) as { pk: string; sk: string; entityType?: string; status?: string };
    if (item.entityType === "INTENT" && item.status === "pending") await runIntent(deps, item);
  }
}

/** Every minute. */
export async function sweep(): Promise<void> {
  const deps = await runtimeDeps();
  const r = await runSweep(deps);
  deps.log?.({ event: "sweep", ...r });
}
