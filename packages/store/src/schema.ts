import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ResourceInUseException,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";

/** The single table: pk/sk, overloaded index gsi1 (gsi1pk/gsi1sk). The CDK stack defines the same shape. */
export const TABLE_SCHEMA = {
  partitionKey: "pk",
  sortKey: "sk",
  index: { name: "gsi1", partitionKey: "gsi1pk", sortKey: "gsi1sk" },
  ttlAttribute: "expiresAt",
} as const;

function rawClient(endpoint?: string) {
  const ep = endpoint ?? process.env.DYNAMODB_ENDPOINT;
  return new DynamoDBClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    ...(ep ? { endpoint: ep, credentials: { accessKeyId: "local", secretAccessKey: "local" } } : {}),
  });
}

/** Create the table if it does not exist (local and test use only; production tables come from CDK). */
export async function createTable(tableName: string, endpoint?: string): Promise<void> {
  const client = rawClient(endpoint);
  try {
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
          { AttributeName: "gsi1pk", AttributeType: "S" },
          { AttributeName: "gsi1sk", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: "gsi1",
            KeySchema: [
              { AttributeName: "gsi1pk", KeyType: "HASH" },
              { AttributeName: "gsi1sk", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          },
        ],
        StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_IMAGE" },
      }),
    );
    await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName });
  } catch (e) {
    if (!(e instanceof ResourceInUseException)) throw e;
  } finally {
    client.destroy();
  }
}

export async function deleteTable(tableName: string, endpoint?: string): Promise<void> {
  const client = rawClient(endpoint);
  try {
    await client.send(new DeleteTableCommand({ TableName: tableName }));
  } catch {
    // already gone
  } finally {
    client.destroy();
  }
}
