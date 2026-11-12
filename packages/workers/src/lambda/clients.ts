import { bedrockAnswerer } from "@rovara-orch/answerer";
import { appClients, GithubAppApi } from "@rovara-orch/github";
import { ActorNotLinked, ChannelClient, Throttled, WorkspaceLimit } from "@rovara-orch/rovara";
import { SlackNotifier, type SlackWebLike } from "@rovara-orch/slack";
import type { AnswererApi, GithubApi, RovaraApi, SlackApi } from "../ports.js";

export interface Clients {
  rovara: RovaraApi;
  github: GithubApi;
  slack: SlackApi;
  answerer: AnswererApi;
}

type Env = Record<string, string | undefined>;

const need = (env: Env, name: string): string => {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set for this deployment`);
  return v;
};

/** A client whose every method is a call to the load stage's fake services (POST <url>/rpc). */
function rpc<T extends object>(url: string, target: string, secret: string, fetchFn: typeof fetch): T {
  return new Proxy({} as T, {
    get: (_t, method) =>
      typeof method !== "string" || method === "then"
        ? undefined
        : async (...args: unknown[]) => {
            const res = await fetchFn(`${url.replace(/\/$/, "")}/rpc`, {
              method: "POST",
              headers: { "content-type": "application/json", "x-load-secret": secret },
              body: JSON.stringify({ target, method, args }),
            });
            const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: { name?: string; message?: string; userId?: string | null } };
            if (!res.ok || body.error) {
              const message = body.error?.message ?? `fake ${target}.${method} answered ${res.status}`;
              // Rovara's refusals keep their classes, so the workers handle them as they would the real ones.
              if (body.error?.name === "ActorNotLinked") throw new ActorNotLinked(body.error.userId ?? "");
              if (body.error?.name === "Throttled") throw new Throttled(null);
              if (body.error?.name === "WorkspaceLimit") throw new WorkspaceLimit(message);
              const e = new Error(message);
              e.name = body.error?.name ?? "Error";
              throw e;
            }
            return body.result;
          },
  });
}

/**
 * The outside-system clients for the deployed functions. Secrets come from the secret store by
 * name (`secret`); nothing secret is in the environment. In the `load` stage only, the fake
 * Rovara, GitHub, Slack and answering model are reached over the load stage's endpoint.
 */
export async function buildClients(env: Env, secret: (name: string) => Promise<string>, fetchFn: typeof fetch = fetch): Promise<Clients> {
  if (env.FAKE_SERVICES_URL) {
    if (env.STAGE !== "load") throw new Error("the fake services may be used only in the load stage");
    const url = env.FAKE_SERVICES_URL;
    const key = env.FAKE_SERVICES_SECRET ?? "";
    return {
      rovara: rpc<RovaraApi>(url, "rovara", key, fetchFn),
      github: rpc<GithubApi>(url, "github", key, fetchFn),
      slack: rpc<SlackApi>(url, "slack", key, fetchFn),
      answerer: rpc<AnswererApi>(url, "model", key, fetchFn),
    };
  }
  const appId = need(env, "GITHUB_APP_ID");
  const installationId = Number(need(env, "GITHUB_INSTALLATION_ID"));
  const [rovaraSecret, githubKey, slackToken] = await Promise.all([secret("ROVARA_SECRET_ARN"), secret("GITHUB_APP_KEY_ARN"), secret("SLACK_TOKEN_ARN")]);
  const { WebClient } = await import("@slack/web-api");
  return {
    rovara: new ChannelClient({ baseUrl: need(env, "ROVARA_URL"), channel: need(env, "ROVARA_CHANNEL"), secret: rovaraSecret }),
    github: new GithubAppApi(appClients({ appId, privateKey: githubKey, installationId })) as unknown as GithubApi,
    slack: new SlackNotifier(new WebClient(slackToken) as unknown as SlackWebLike),
    answerer: await bedrockAnswerer({ awsRegion: need(env, "AWS_REGION") }),
  };
}
