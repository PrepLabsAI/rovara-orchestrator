import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { AttributeType, BillingMode, StreamViewType, Table, type ITable } from "aws-cdk-lib/aws-dynamodb";
import { BlockPublicAccess, Bucket, BucketEncryption, type IBucket } from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import { createSecrets, type OrchestratorSecrets } from "./secrets.js";
import type { StageConfig } from "./stage.js";

export interface DataStackProps extends StackProps {
  stage: StageConfig;
}

/** The single table, the bucket for large imported DAG files, and the secret entries. */
export class DataStack extends Stack {
  readonly table: ITable;
  readonly dagBucket: IBucket;
  readonly secrets: OrchestratorSecrets;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const removalPolicy = props.stage.prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const table = new Table(this, "Table", {
      partitionKey: { name: "pk", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: "expiresAt",
      stream: StreamViewType.NEW_IMAGE,
      removalPolicy,
    });
    table.addGlobalSecondaryIndex({
      indexName: "gsi1",
      partitionKey: { name: "gsi1pk", type: AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: AttributeType.STRING },
    });
    this.table = table;
    this.dagBucket = new Bucket(this, "DagFiles", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
    });
    this.secrets = createSecrets(this, props.stage);
  }
}
