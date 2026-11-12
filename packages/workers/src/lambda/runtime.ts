import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SQSClient } from "@aws-sdk/client-sqs";
import { systemClock } from "@rovara-orch/core";
import { Repositories, Table } from "@rovara-orch/store";
import type { Deps } from "../ports.js";
import { buildClients } from "./clients.js";
import { SqsWorkQueue } from "../sqs-queue.js";

/**
 * Builds the workers' dependencies from the Lambda environment, once per container.
 * Secrets are read from Secrets Manager by ARN; nothing secret is in the environment.
 */
const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

const secrets = new SecretsManagerClient({});
const secretCache = new Map<string, string>();
export async function secret(arnEnv: string): Promise<string> {
  const arn = env(arnEnv);
  const hit = secretCache.get(arn);
  if (hit) return hit;
  const r = await secrets.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!r.SecretString) throw new Error(`secret ${arnEnv} is empty`);
  secretCache.set(arn, r.SecretString);
  return r.SecretString;
}

let cached: Promise<Deps> | undefined;
export function runtimeDeps(): Promise<Deps> {
  cached ??= (async () => {
    const table = new Table({ tableName: env("TABLE_NAME") });
    const c = await buildClients(process.env, secret);
    return {
      table,
      repos: new Repositories(table),
      clock: systemClock,
      queue: new SqsWorkQueue(new SQSClient({}), env("QUEUE_URL")),
      rovara: c.rovara,
      github: c.github,
      slack: c.slack,
      answerer: c.answerer,
      config: {
        rovaraTenant: env("ROVARA_TENANT"),
        rovaraSpace: env("ROVARA_SPACE"),
        channel: env("ROVARA_CHANNEL"),
        statusPageUrl: env("STATUS_PAGE_URL"),
      },
      operators: { isRovaraAdmin: async () => false },
      log: (entry) => console.log(JSON.stringify({ component: "rovara-orch", ...entry })),
    };
  })();
  return cached;
}
