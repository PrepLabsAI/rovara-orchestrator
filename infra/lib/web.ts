import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { Distribution, ViewerProtocolPolicy } from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";
import type { StageConfig } from "./stage.js";

export interface WebStackProps extends StackProps {
  stage: StageConfig;
}

const built = fileURLToPath(new URL("../../packages/web/dist", import.meta.url));

/**
 * The read-only status page (FR-053): a private bucket read only by CloudFront through origin
 * access control, served over HTTPS. The page's files are uploaded when `packages/web` has been
 * built (`npm run -w packages/web build`).
 */
export class WebStack extends Stack {
  /** The page's origin, e.g. `https://d111111abcdef8.cloudfront.net`; the API allows only this origin. */
  readonly origin: string;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);
    const bucket = new Bucket(this, "Page", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: props.stage.prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    const distribution = new Distribution(this, "Cdn", {
      defaultRootObject: "index.html",
      defaultBehavior: { origin: S3BucketOrigin.withOriginAccessControl(bucket), viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS },
      comment: `rovara-orch ${props.stage.name} status page`,
    });
    this.origin = `https://${distribution.distributionDomainName}`;
    if (existsSync(built)) {
      new BucketDeployment(this, "Upload", { sources: [Source.asset(built)], destinationBucket: bucket, distribution, distributionPaths: ["/*"] });
    }
    new CfnOutput(this, "StatusPageUrl", { value: this.origin });
  }
}
