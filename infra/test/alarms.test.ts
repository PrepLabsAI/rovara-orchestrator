import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, test } from "vitest";
import { DataStack } from "../lib/data.js";
import { ServiceStack } from "../lib/service.js";
import { stageConfig } from "../lib/stage.js";

function template() {
  const app = new App({ context: { "aws:cdk:bundling-stacks": [] } });
  const stage = stageConfig("test");
  return Template.fromStack(new ServiceStack(app, "Service", { stage, data: new DataStack(app, "Data", { stage }) }));
}

type Alarm = { Properties: { AlarmName?: string; MetricName?: string; Namespace?: string; Threshold: number; ComparisonOperator: string; TreatMissingData?: string; AlarmActions?: unknown[]; Dimensions?: Array<{ Name: string; Value: unknown }> } };

describe("alarms and dashboard (T122)", () => {
  const alarms = () => Object.values(template().findResources("AWS::CloudWatch::Alarm")) as Alarm[];
  const named = (part: string) => alarms().find((a) => String(a.Properties.AlarmName).includes(part));

  test("the dead-letter queue having any message alarms", () => {
    const a = named("dlq-depth")!;
    expect(a.Properties).toMatchObject({ MetricName: "ApproximateNumberOfMessagesVisible", Namespace: "AWS/SQS", Threshold: 0, ComparisonOperator: "GreaterThanThreshold" });
  });

  test("an intent that failed after its last try alarms", () => {
    expect(named("failed-intents")!.Properties).toMatchObject({ MetricName: "FailedIntents", Namespace: "RovaraOrch/test", Threshold: 0, ComparisonOperator: "GreaterThanThreshold" });
  });

  test("ingress 5xx and work-consumer errors alarm", () => {
    expect(named("ingress-5xx")!.Properties).toMatchObject({ Namespace: "AWS/ApiGateway", Threshold: 0, ComparisonOperator: "GreaterThanThreshold" });
    expect(named("consumer-errors")!.Properties).toMatchObject({ MetricName: "Errors", Namespace: "AWS/Lambda", Threshold: 0 });
  });

  test("no scheduler pass for 3 minutes alarms, and missing data counts as breaching", () => {
    expect(named("scheduler-stalled")!.Properties).toMatchObject({ MetricName: "SchedulerPasses", ComparisonOperator: "LessThanThreshold", Threshold: 1, TreatMissingData: "breaching" });
  });

  test("every alarm notifies one topic, and there is one dashboard", () => {
    const t = template();
    t.resourceCountIs("AWS::SNS::Topic", 1);
    expect(alarms().length).toBeGreaterThanOrEqual(5);
    for (const a of alarms()) expect(a.Properties.AlarmActions).toHaveLength(1);
    t.resourceCountIs("AWS::CloudWatch::Dashboard", 1);
    t.hasResourceProperties("AWS::Logs::MetricFilter", { FilterPattern: Match.stringLikeRegexp("intent.failed") });
  });
});
