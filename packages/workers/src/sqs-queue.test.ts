import { describe, expect, test } from "vitest";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { sqsId, SqsWorkQueue } from "./sqs-queue.js";

describe("SqsWorkQueue", () => {
  test("sends in batches of 10 with group and deduplication ids", async () => {
    const sent: Array<{ input: { Entries: Array<{ MessageGroupId: string; MessageDeduplicationId: string }> } }> = [];
    const sqs = { send: async (cmd: never) => (sent.push(cmd), { Failed: [] }) } as unknown as SQSClient;
    const q = new SqsWorkQueue(sqs, "https://sqs/q.fifo");
    const msgs = Array.from({ length: 23 }, (_, i) => ({ group: "att:att_x" as const, input: { kind: "start" as const }, inputId: `in-${i}` }));
    await q.send(msgs);
    expect(sent.map((c) => c.input.Entries.length)).toEqual([10, 10, 3]);
    expect(sent[0]!.input.Entries[0]).toMatchObject({ MessageGroupId: "att:att_x", MessageDeduplicationId: "in-0" });
  });

  test("hashes ids that are too long for SQS", () => {
    expect(sqsId("short:id")).toBe("short:id");
    expect(sqsId("x".repeat(200))).toMatch(/^[0-9a-f]{64}$/);
  });

  test("throws when SQS refuses messages", async () => {
    const sqs = { send: async () => ({ Failed: [{ Id: "0", Message: "nope" }] }) } as unknown as SQSClient;
    await expect(new SqsWorkQueue(sqs, "u").send([{ group: "run:r", input: { kind: "run_start" }, inputId: "a" }])).rejects.toThrow(/refused/);
  });
});
