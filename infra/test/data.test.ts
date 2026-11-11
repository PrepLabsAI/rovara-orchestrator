import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, test } from "vitest";
import { DataStack } from "../lib/data.js";
import { stageConfig } from "../lib/stage.js";

function template() {
  const app = new App();
  return Template.fromStack(new DataStack(app, "Data", { stage: stageConfig("test") }));
}

describe("DataStack", () => {
  test("one table: pk/sk, on-demand, point-in-time recovery, TTL expiresAt, NEW_IMAGE stream, gsi1", () => {
    const t = template();
    t.resourceCountIs("AWS::DynamoDB::Table", 1);
    t.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
      StreamSpecification: { StreamViewType: "NEW_IMAGE" },
      GlobalSecondaryIndexes: [
        Match.objectLike({
          IndexName: "gsi1",
          KeySchema: [
            { AttributeName: "gsi1pk", KeyType: "HASH" },
            { AttributeName: "gsi1sk", KeyType: "RANGE" },
          ],
        }),
      ],
    });
  });

  test("the DAG bucket blocks public access", () => {
    template().hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    });
  });

  test("the four secret entries exist", () => {
    const t = template();
    t.resourceCountIs("AWS::SecretsManager::Secret", 4);
    const names = Object.values(t.findResources("AWS::SecretsManager::Secret")).map((r) => (r as { Properties: { Name: string } }).Properties.Name);
    expect(names.sort()).toEqual(
      ["rovara-orch/test/github-app-private-key", "rovara-orch/test/github-webhook-secret", "rovara-orch/test/rovara-adapter-secret", "rovara-orch/test/slack-token"].sort(),
    );
  });
});
