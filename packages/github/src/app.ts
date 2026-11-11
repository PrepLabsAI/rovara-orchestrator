import { createAppAuth } from "@octokit/auth-app";
import { graphql } from "@octokit/graphql";
import { Octokit } from "@octokit/rest";

export interface AppCredentials {
  appId: string;
  privateKey: string;
  installationId: number;
}

export interface GithubClients {
  rest: Octokit;
  graphql: typeof graphql;
}

/** Octokit REST and GraphQL clients authenticated as the orchestrator's GitHub App installation. */
export function appClients(creds: AppCredentials, baseUrl?: string): GithubClients {
  const auth = { appId: creds.appId, privateKey: creds.privateKey, installationId: creds.installationId };
  const rest = new Octokit({ authStrategy: createAppAuth, auth, ...(baseUrl ? { baseUrl } : {}) });
  const appAuth = createAppAuth(auth);
  const gql = graphql.defaults({
    ...(baseUrl ? { baseUrl } : {}),
    request: {
      hook: async (request: (o: unknown) => Promise<unknown>, options: Record<string, unknown>) => {
        // auth-app caches installation tokens until shortly before they expire
        const { token } = await appAuth({ type: "installation" });
        const headers = { ...(options.headers as Record<string, string>), authorization: `token ${token}` };
        return request({ ...options, headers });
      },
    },
  }) as typeof graphql;
  return { rest, graphql: gql };
}
