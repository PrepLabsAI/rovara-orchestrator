import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SQSClient } from "@aws-sdk/client-sqs";
import { systemClock } from "@rovara-orch/core";
import { ChannelClient } from "@rovara-orch/rovara";
import { Repositories, Table } from "@rovara-orch/store";
import type { AnswererApi, Deps, GithubApi, SlackApi } from "../ports.js";
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

/** Outside-system clients, plugged in by the stories that implement them (GitHub, Slack, answerer). */
export interface Clients {
  github: () => Promise<GithubApi>;
  slack: () => Promise<SlackApi>;
  answerer: () => Promise<AnswererApi>;
}

const unavailable = <T extends object>(what: string): T =>
  new Proxy({} as T, {
    get: (_t, prop) => async () => {
      throw new Error(`${what}.${String(prop)} is not wired in this deployment yet`);
    },
  });

export const clients: Clients = {
  github: async () => unavailable<GithubApi>("github"),
  slack: async () => unavailable<SlackApi>("slack"),
  answerer: async () => unavailable<AnswererApi>("answerer"),
};

let cached: Promise<Deps> | undefined;
export function runtimeDeps(): Promise<Deps> {
  cached ??= (async () => {
    const table = new Table({ tableName: env("TABLE_NAME") });
    return {
      table,
      repos: new Repositories(table),
      clock: systemClock,
      queue: new SqsWorkQueue(new SQSClient({}), env("QUEUE_URL")),
      rovara: new ChannelClient({ baseUrl: env("ROVARA_URL"), channel: env("ROVARA_CHANNEL"), secret: await secret("ROVARA_SECRET_ARN") }),
      github: await clients.github(),
      slack: await clients.slack(),
      answerer: await clients.answerer(),
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
