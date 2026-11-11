import { DynamoDBClient, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import type { Key } from "./keys.js";

export type Item = Key & Record<string, unknown>;

/** One write in a transaction. Writes to the same key are merged into one (DynamoDB allows one per item). */
export type Op =
  | {
      kind: "put";
      item: Item;
      ifNotExists?: boolean;
      /** A custom condition, e.g. a lease that may be taken when expired. */
      condition?: { expression: string; names?: Record<string, string>; values?: Record<string, unknown> };
    }
  | {
      kind: "update";
      key: Key;
      set?: Record<string, unknown>;
      remove?: string[];
      /** Atomic additions to numeric attributes, outside any version check. */
      add?: Record<string, number>;
      /** When set, the update requires `version = expectedVersion` and sets `version = expectedVersion + 1`. */
      expectedVersion?: number;
      /** Require the item to exist (without checking its version). */
      ifExists?: boolean;
    }
  | { kind: "delete"; key: Key; ifExists?: boolean }
  | { kind: "check"; key: Key; exists: boolean };

export class ConditionFailed extends Error {
  constructor(readonly failed: Op[]) {
    super(`condition failed on ${failed.map((o) => keyOf(o).pk + "|" + keyOf(o).sk).join(", ")}`);
    this.name = "ConditionFailed";
  }
}

/** A version-checked update lost a race; re-read and recompute. */
export class VersionConflict extends ConditionFailed {
  constructor(failed: Op[]) {
    super(failed);
    this.name = "VersionConflict";
  }
}

export interface TableOptions {
  tableName: string;
  endpoint?: string;
  region?: string;
}

const keyOf = (op: Op): Key => (op.kind === "put" ? { pk: op.item.pk, sk: op.item.sk } : { pk: op.key.pk, sk: op.key.sk });
/** Only pk and sk: callers may pass a whole item as its key. */
export const onlyKey = (key: Key): Key => ({ pk: key.pk, sk: key.sk });
const keyId = (key: Key) => `${key.pk}\u0000${key.sk}`;

export function createDocumentClient(opts: { endpoint?: string; region?: string } = {}): DynamoDBDocumentClient {
  const endpoint = opts.endpoint ?? process.env.DYNAMODB_ENDPOINT;
  const client = new DynamoDBClient({
    region: opts.region ?? process.env.AWS_REGION ?? "us-east-1",
    ...(endpoint
      ? { endpoint, credentials: { accessKeyId: "local", secretAccessKey: "local" } }
      : {}),
  });
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true },
  });
}

/** Merge ops that target the same key into one, so a transaction touches each item once. */
export function mergeOps(ops: Op[]): Op[] {
  const out = new Map<string, Op>();
  for (const op of ops) {
    const id = keyId(keyOf(op));
    const prev = out.get(id);
    if (!prev) {
      out.set(id, op);
      continue;
    }
    if (prev.kind === "update" && op.kind === "update") {
      if (prev.expectedVersion !== undefined && op.expectedVersion !== undefined && prev.expectedVersion !== op.expectedVersion) {
        throw new Error(`two different expected versions for ${id}`);
      }
      out.set(id, {
        kind: "update",
        key: prev.key,
        set: { ...prev.set, ...op.set },
        remove: [...(prev.remove ?? []), ...(op.remove ?? [])],
        add: mergeAdds(prev.add, op.add),
        expectedVersion: prev.expectedVersion ?? op.expectedVersion,
        ifExists: prev.ifExists || op.ifExists,
      });
      continue;
    }
    throw new Error(`cannot combine a ${prev.kind} and a ${op.kind} on ${id}`);
  }
  return [...out.values()];
}

function mergeAdds(a?: Record<string, number>, b?: Record<string, number>): Record<string, number> | undefined {
  if (!a) return b;
  if (!b) return a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
}

type TransactItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

function toTransactItem(tableName: string, op: Op): TransactItem {
  switch (op.kind) {
    case "put":
      return {
        Put: {
          TableName: tableName,
          Item: op.item,
          ...(op.ifNotExists ? { ConditionExpression: "attribute_not_exists(pk)" } : {}),
          ...(op.condition
            ? {
                ConditionExpression: op.condition.expression,
                ...(op.condition.names ? { ExpressionAttributeNames: op.condition.names } : {}),
                ...(op.condition.values ? { ExpressionAttributeValues: op.condition.values } : {}),
              }
            : {}),
        },
      };
    case "delete":
      return {
        Delete: {
          TableName: tableName,
          Key: onlyKey(op.key),
          ...(op.ifExists ? { ConditionExpression: "attribute_exists(pk)" } : {}),
        },
      };
    case "check":
      return {
        ConditionCheck: {
          TableName: tableName,
          Key: onlyKey(op.key),
          ConditionExpression: op.exists ? "attribute_exists(pk)" : "attribute_not_exists(pk)",
        },
      };
    case "update": {
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      const sets: string[] = [];
      const adds: string[] = [];
      const removes: string[] = [];
      let i = 0;
      for (const [field, value] of Object.entries(op.set ?? {})) {
        if (field === "pk" || field === "sk" || field === "version") continue;
        if (value === undefined) {
          removes.push(`#n${i}`);
          names[`#n${i}`] = field;
          i++;
          continue;
        }
        names[`#n${i}`] = field;
        values[`:v${i}`] = value;
        sets.push(`#n${i} = :v${i}`);
        i++;
      }
      for (const field of op.remove ?? []) {
        names[`#n${i}`] = field;
        removes.push(`#n${i}`);
        i++;
      }
      for (const [field, delta] of Object.entries(op.add ?? {})) {
        if (delta === 0) continue;
        names[`#n${i}`] = field;
        values[`:v${i}`] = delta;
        adds.push(`#n${i} :v${i}`);
        i++;
      }
      const conditions: string[] = [];
      if (op.expectedVersion !== undefined) {
        names["#version"] = "version";
        values[":expected"] = op.expectedVersion;
        values[":next"] = op.expectedVersion + 1;
        sets.push("#version = :next");
        conditions.push("#version = :expected");
      } else if (op.ifExists) {
        conditions.push("attribute_exists(pk)");
      }
      const parts = [
        sets.length ? `SET ${sets.join(", ")}` : "",
        removes.length ? `REMOVE ${removes.join(", ")}` : "",
        adds.length ? `ADD ${adds.join(", ")}` : "",
      ].filter(Boolean);
      if (parts.length === 0) throw new Error(`empty update on ${keyId(op.key)}`);
      return {
        Update: {
          TableName: tableName,
          Key: onlyKey(op.key),
          UpdateExpression: parts.join(" "),
          ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
          ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
          ...(conditions.length ? { ConditionExpression: conditions.join(" AND ") } : {}),
        },
      };
    }
  }
}

export interface QueryOptions {
  limit?: number;
  /** Exclusive lower bound on sk (for paging forward). */
  after?: string;
  descending?: boolean;
}

export class Table {
  readonly doc: DynamoDBDocumentClient;
  readonly tableName: string;

  constructor(opts: TableOptions & { doc?: DynamoDBDocumentClient }) {
    this.tableName = opts.tableName;
    this.doc = opts.doc ?? createDocumentClient(opts);
  }

  async get<T = Item>(key: Key, consistent = true): Promise<T | undefined> {
    const r = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: onlyKey(key), ConsistentRead: consistent }));
    return r.Item as T | undefined;
  }

  /** Items under `pk` whose sk starts with `skPrefix`, following pages until `limit`. */
  async query<T = Item>(pk: string, skPrefix: string, opts: QueryOptions = {}): Promise<T[]> {
    const out: T[] = [];
    let start: Record<string, unknown> | undefined;
    const names: Record<string, string> = { "#pk": "pk" };
    const values: Record<string, unknown> = { ":pk": pk };
    let cond = "#pk = :pk";
    if (opts.after !== undefined) {
      cond += " AND #sk > :after";
      names["#sk"] = "sk";
      values[":after"] = opts.after;
    } else if (skPrefix) {
      cond += " AND begins_with(#sk, :p)";
      names["#sk"] = "sk";
      values[":p"] = skPrefix;
    }
    do {
      const r = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: cond,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ConsistentRead: true,
          ScanIndexForward: !opts.descending,
          ...(opts.limit ? { Limit: opts.limit - out.length } : {}),
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      );
      for (const item of r.Items ?? []) {
        if (opts.after !== undefined && skPrefix && !String(item.sk).startsWith(skPrefix)) {
          start = undefined;
          return out;
        }
        out.push(item as T);
      }
      start = r.LastEvaluatedKey;
    } while (start && (!opts.limit || out.length < opts.limit));
    return out;
  }

  /** Items on the overloaded `gsi1` index with `gsi1pk`, and `gsi1sk` up to `upTo` (inclusive) when given. */
  async queryIndex<T = Item>(gsi1pk: string, opts: { upTo?: string; prefix?: string; limit?: number } = {}): Promise<T[]> {
    const out: T[] = [];
    let start: Record<string, unknown> | undefined;
    const names: Record<string, string> = { "#g": "gsi1pk" };
    const values: Record<string, unknown> = { ":g": gsi1pk };
    let cond = "#g = :g";
    if (opts.upTo !== undefined) {
      names["#s"] = "gsi1sk";
      values[":upTo"] = opts.upTo;
      cond += " AND #s <= :upTo";
    } else if (opts.prefix !== undefined) {
      names["#s"] = "gsi1sk";
      values[":p"] = opts.prefix;
      cond += " AND begins_with(#s, :p)";
    }
    do {
      const r = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: "gsi1",
          KeyConditionExpression: cond,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ...(opts.limit ? { Limit: opts.limit - out.length } : {}),
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      );
      out.push(...((r.Items ?? []) as T[]));
      start = r.LastEvaluatedKey;
    } while (start && (!opts.limit || out.length < opts.limit));
    return out;
  }

  /**
   * Write all ops in one transaction, or none. A failed condition throws VersionConflict when a
   * version-checked update lost, otherwise ConditionFailed listing the ops whose condition failed.
   */
  async transact(ops: Op[]): Promise<void> {
    const merged = mergeOps(ops);
    if (merged.length === 0) return;
    if (merged.length > 100) throw new Error(`a transaction holds at most 100 writes, got ${merged.length}`);
    try {
      await this.doc.send(
        new TransactWriteCommand({ TransactItems: merged.map((op) => toTransactItem(this.tableName, op)) }),
      );
    } catch (e) {
      if (e instanceof TransactionCanceledException || (e as { name?: string }).name === "TransactionCanceledException") {
        const reasons = (e as TransactionCanceledException).CancellationReasons ?? [];
        const failed = merged.filter((_, i) => reasons[i]?.Code === "ConditionalCheckFailed");
        if (failed.length === 0) throw e;
        const versioned = failed.some((op) => op.kind === "update" && op.expectedVersion !== undefined);
        throw versioned ? new VersionConflict(failed) : new ConditionFailed(failed);
      }
      throw e;
    }
  }
}

/** Run `fn` against fresh reads, retrying when it loses a version race. */
export async function withFreshRead<T>(fn: () => Promise<T>, maxTries = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < maxTries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof VersionConflict)) throw e;
      last = e;
    }
  }
  throw last;
}
