import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { handle, type ApiDeps } from "@rovara-orch/api";
import { DevIdentity } from "@rovara-orch/identity";
import { runtimeDeps, secret } from "./runtime.js";

let cached: Promise<ApiDeps> | undefined;

function apiDeps(): Promise<ApiDeps> {
  cached ??= (async () => {
    const d = await runtimeDeps();
    const operators = JSON.parse(process.env.DEV_OPERATORS ?? "[]") as Array<{ id: string; name: string; admin: boolean }>;
    // Development-only identity until Rovara#442; it refuses to run in prod.
    const identity = new DevIdentity({ stage: process.env.STAGE ?? "test", operators, signingKey: await secret("ROVARA_SECRET_ARN") });
    return {
      table: d.table,
      repos: d.repos,
      identity,
      clock: d.clock,
      github: { commitOnRemote: (repo, sha) => d.github.commitOnRemote(repo, sha) },
      rovara: { linkUrl: async () => null, isLinked: async () => true },
      config: { statusPageUrl: d.config.statusPageUrl },
    };
  })();
  return cached;
}

export async function apiHandler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const raw = event.isBase64Encoded && event.body ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    return { statusCode: 422, body: JSON.stringify({ error: { code: "INVALID", message: "body is not JSON" } }) };
  }
  const r = await handle(await apiDeps(), {
    method: event.requestContext.http.method,
    path: event.rawPath,
    headers: event.headers,
    query: (event.queryStringParameters ?? {}) as Record<string, string | undefined>,
    body,
  });
  return { statusCode: r.status, headers: { "content-type": "application/json" }, body: JSON.stringify(r.body) };
}
