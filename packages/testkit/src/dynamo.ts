import { createTable, deleteTable, Repositories, Table } from "@rovara-orch/store";

export const DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";

/** A fresh table on DynamoDB Local for one test file; call `drop` in afterAll. */
export async function freshTable(name: string): Promise<{ table: Table; repos: Repositories; drop: () => Promise<void> }> {
  const tableName = `t-${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await createTable(tableName, DYNAMODB_ENDPOINT);
  const table = new Table({ tableName, endpoint: DYNAMODB_ENDPOINT });
  return { table, repos: new Repositories(table), drop: () => deleteTable(tableName, DYNAMODB_ENDPOINT) };
}
