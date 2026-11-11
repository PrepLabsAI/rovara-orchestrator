import { createHash } from "node:crypto";
import { SendMessageBatchCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { QueueMessage } from "@rovara-orch/core";
import type { WorkQueue } from "./ports.js";

const SQS_ID_RE = /^[A-Za-z0-9!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]{1,128}$/;

/** SQS ids allow at most 128 printable characters; longer or unusual ids are hashed. */
export function sqsId(s: string): string {
  return SQS_ID_RE.test(s) ? s : createHash("sha256").update(s).digest("hex");
}

/** The work queue on SQS FIFO: message group = the input's group, deduplication id = its input id. */
export class SqsWorkQueue implements WorkQueue {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async send(messages: QueueMessage[]): Promise<void> {
    for (let i = 0; i < messages.length; i += 10) {
      const batch = messages.slice(i, i + 10);
      const r = await this.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: this.queueUrl,
          Entries: batch.map((m, j) => ({
            Id: String(j),
            MessageBody: JSON.stringify(m),
            MessageGroupId: sqsId(m.group),
            MessageDeduplicationId: sqsId(m.inputId),
          })),
        }),
      );
      if (r.Failed?.length) throw new Error(`SQS refused ${r.Failed.length} messages: ${r.Failed.map((f) => f.Message).join("; ")}`);
    }
  }
}
