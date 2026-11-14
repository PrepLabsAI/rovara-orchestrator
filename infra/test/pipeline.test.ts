import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, test } from "vitest";
import { PipelineStack } from "../lib/pipeline.js";
import { stageConfig } from "../lib/stage.js";

const connectionArn = "arn:aws:codeconnections:us-east-1:111111111111:connection/7e76074b-e840-439f-b94c-6806a2bf9513";

function template() {
  const app = new App();
  const stack = new PipelineStack(app, "Pipeline", {
    stage: stageConfig("test"),
    connectionArn,
    repository: "PrepLabsAI/rovara-orchestrator",
    branch: "main",
    env: { account: "111111111111", region: "us-east-1" },
  });
  return Template.fromStack(stack);
}

type Phase = { commands: string[] };
function buildCommands(t: Template): string[] {
  const projects = Object.values(t.findResources("AWS::CodeBuild::Project")) as Array<{ Properties: { Source: { BuildSpec: string } } }>;
  expect(projects).toHaveLength(1);
  const spec = JSON.parse(projects[0]!.Properties.Source.BuildSpec) as { phases: Record<string, Phase> };
  return ["install", "pre_build", "build"].flatMap((p) => spec.phases[p]?.commands ?? []);
}

describe("deploy pipeline", () => {
  test("pushes to the branch start it, through the GitHub connection, one release at a time in order", () => {
    const t = template();
    t.hasResourceProperties("AWS::CodePipeline::Pipeline", {
      PipelineType: "V2",
      ExecutionMode: "QUEUED",
      Stages: Match.arrayWith([
        Match.objectLike({
          Name: "Source",
          Actions: [Match.objectLike({
            ActionTypeId: Match.objectLike({ Provider: "CodeStarSourceConnection" }),
            Configuration: Match.objectLike({ ConnectionArn: connectionArn, FullRepositoryId: "PrepLabsAI/rovara-orchestrator", BranchName: "main" }),
          })],
        }),
      ]),
    });
  });

  test("every test suite passes before anything is deployed, and the tests cannot reach real AWS", () => {
    const commands = buildCommands(template());
    const firstDeploy = commands.findIndex((c) => c.includes("npm run deploy"));
    expect(firstDeploy).toBeGreaterThan(0);
    const before = commands.slice(0, firstDeploy).join("\n");
    for (const step of ["npm run lint", "npm run typecheck", "npm test", "npm run test:contract", "npm run test:integration", "npm run test:fault"]) {
      expect(before).toContain(step);
    }
    for (const c of commands.filter((c) => /npm (test|run test:)/.test(c))) {
      expect(c).toContain("AWS_ACCESS_KEY_ID=local");
      expect(c).toContain("DYNAMODB_ENDPOINT=http://localhost:8000");
    }
    expect(before).toMatch(/docker run .*dynamodb-local/);
  });

  test("it deploys its own stage without prompts, and builds the status page against the stage's API", () => {
    const commands = buildCommands(template()).join("\n");
    expect(commands).toContain("npm run deploy -- -c stage=test --require-approval never");
    expect(commands).toContain("RovaraOrch-test-Service");
    expect(commands).toMatch(/VITE_API_URL="\$api_url" npm run -w packages\/web build/);
    expect(commands).not.toContain("stage=prod");
  });

  test("the build role can only use the CDK bootstrap roles and read its own stage's stacks", () => {
    const t = template();
    const project = Object.values(t.findResources("AWS::CodeBuild::Project"))[0] as { Properties: { ServiceRole: { "Fn::GetAtt": [string, string] } } };
    const buildRole = project.Properties.ServiceRole["Fn::GetAtt"][0];
    const policies = Object.values(t.findResources("AWS::IAM::Policy")) as Array<{ Properties: { Roles: Array<{ Ref: string }>; PolicyDocument: { Statement: Array<{ Action: string | string[]; Resource: unknown }> } } }>;
    const statements = policies.filter((p) => p.Properties.Roles.some((r) => r.Ref === buildRole)).flatMap((p) => p.Properties.PolicyDocument.Statement);
    const assume = statements.filter((s) => [s.Action].flat().includes("sts:AssumeRole"));
    expect(assume.length).toBeGreaterThan(0);
    for (const s of assume) expect(JSON.stringify(s.Resource)).toContain("cdk-hnb659fds-");
    const describe = statements.filter((s) => [s.Action].flat().includes("cloudformation:DescribeStacks"));
    expect(describe).toHaveLength(1);
    expect(JSON.stringify(describe[0]!.Resource)).toContain("stack/RovaraOrch-test-");
    expect(statements.filter((s) => [s.Action].flat().some((a) => a === "*" || a.endsWith(":*")))).toEqual([]);
  });

  test("the build runs privileged (DynamoDB Local runs in Docker), one at a time", () => {
    template().hasResourceProperties("AWS::CodeBuild::Project", {
      Environment: Match.objectLike({ PrivilegedMode: true }),
      ConcurrentBuildLimit: 1,
    });
  });

  test("the pipeline cannot deploy prod while prod refuses the development sign-in", () => {
    expect(() => new PipelineStack(new App(), "P", { stage: stageConfig("prod"), connectionArn, repository: "o/r", branch: "main" })).toThrow(/prod/);
  });
});
