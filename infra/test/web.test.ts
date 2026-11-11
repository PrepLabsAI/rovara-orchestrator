import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, test } from "vitest";
import { DataStack } from "../lib/data.js";
import { ServiceStack } from "../lib/service.js";
import { stageConfig } from "../lib/stage.js";
import { WebStack } from "../lib/web.js";

function stacks() {
  const app = new App({ context: { "aws:cdk:bundling-stacks": [] } });
  const stage = stageConfig("test");
  const web = new WebStack(app, "Web", { stage });
  const data = new DataStack(app, "Data", { stage });
  const service = new ServiceStack(app, "Service", { stage, data, pageOrigin: web.origin });
  return { web: Template.fromStack(web), service: Template.fromStack(service) };
}

describe("status page hosting (T107)", () => {
  test("the page bucket is not public: every public access block is on, and it has no website hosting", () => {
    const { web } = stacks();
    web.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    });
    for (const b of Object.values(web.findResources("AWS::S3::Bucket"))) {
      expect((b as { Properties: Record<string, unknown> }).Properties.WebsiteConfiguration).toBeUndefined();
    }
  });

  test("the bucket is read only by CloudFront, through origin access control", () => {
    const { web } = stacks();
    web.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
    web.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: "Allow", Action: "s3:GetObject", Principal: { Service: "cloudfront.amazonaws.com" }, Condition: Match.objectLike({ StringEquals: Match.anyValue() }) }),
        ]),
      },
    });
    const statements = Object.values(web.findResources("AWS::S3::BucketPolicy")).flatMap(
      (p) => (p as { Properties: { PolicyDocument: { Statement: Array<{ Effect: string; Principal: unknown }> } } }).Properties.PolicyDocument.Statement,
    );
    expect(statements.filter((s) => s.Effect === "Allow" && JSON.stringify(s.Principal).includes('"*"'))).toEqual([]);
  });

  test("CloudFront serves the page over HTTPS only, from index.html", () => {
    const { web } = stacks();
    web.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({ DefaultRootObject: "index.html", DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: "redirect-to-https" }) }),
    });
  });

  test("the API allows only the page's origin, and only the GET routes' method from it", () => {
    const { service } = stacks();
    const apis = Object.values(service.findResources("AWS::ApiGatewayV2::Api")) as Array<{ Properties: { CorsConfiguration?: { AllowOrigins: unknown[]; AllowMethods: string[]; AllowHeaders: string[] } } }>;
    const cors = apis[0]!.Properties.CorsConfiguration!;
    expect(cors.AllowOrigins).toHaveLength(1);
    expect(JSON.stringify(cors.AllowOrigins)).not.toContain('"*"');
    expect(JSON.stringify(cors.AllowOrigins)).toMatch(/https:\/\//);
    expect(cors.AllowMethods).toEqual(["GET"]);
    expect(cors.AllowHeaders).toEqual(["authorization"]);
  });
});
