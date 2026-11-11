import { RemovalPolicy } from "aws-cdk-lib";
import { Secret, type ISecret } from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import type { StageConfig } from "./stage.js";

export interface OrchestratorSecrets {
  rovaraAdapterSecret: ISecret;
  githubAppPrivateKey: ISecret;
  githubWebhookSecret: ISecret;
  slackToken: ISecret;
}

/** The secret store entries (constitution: secrets never in code, configuration files or logs). */
export function createSecrets(scope: Construct, stage: StageConfig): OrchestratorSecrets {
  const make = (id: string, name: string, description: string) =>
    new Secret(scope, id, {
      secretName: `rovara-orch/${stage.name}/${name}`,
      description,
      removalPolicy: stage.prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
  return {
    rovaraAdapterSecret: make("RovaraAdapterSecret", "rovara-adapter-secret", "Signing secret Rovara returned when the orchestrator adapter was registered"),
    githubAppPrivateKey: make("GithubAppPrivateKey", "github-app-private-key", "Private key of the orchestrator's GitHub App"),
    githubWebhookSecret: make("GithubWebhookSecret", "github-webhook-secret", "Webhook secret of the orchestrator's GitHub App"),
    slackToken: make("SlackToken", "slack-token", "Bot token of the orchestrator's Slack app (chat:write)"),
  };
}
