import { Duration } from "aws-cdk-lib";
import type { HttpApi } from "aws-cdk-lib/aws-apigatewayv2";
import { Alarm, ComparisonOperator, Dashboard, GraphWidget, Metric, TreatMissingData, type IMetric } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { FilterPattern, MetricFilter } from "aws-cdk-lib/aws-logs";
import { Topic } from "aws-cdk-lib/aws-sns";
import type { Queue } from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import type { StageConfig } from "./stage.js";

export interface AlarmTargets {
  stage: StageConfig;
  api: HttpApi;
  dlq: Queue;
  consumer: NodejsFunction;
  intentRunner: NodejsFunction;
  sweep: NodejsFunction;
}

/**
 * Alarms and one dashboard (T122): any message on the dead-letter queue, an intent that failed
 * after its last try, 5xx from the ingresses or the API, work-consumer errors, and no scheduler
 * pass for 3 minutes while runs are active. Every alarm notifies one SNS topic.
 */
export function addAlarms(scope: Construct, t: AlarmTargets): Topic {
  const name = (s: string) => `rovara-orch-${t.stage.name}-${s}`;
  const namespace = `RovaraOrch/${t.stage.name}`;
  const topic = new Topic(scope, "Alarms", { topicName: name("alarms") });
  const action = new SnsAction(topic);

  // Workers log one JSON line per event; these become metrics.
  const fromLogs = (id: string, fn: NodejsFunction, pattern: string, metricName: string) =>
    new MetricFilter(scope, id, { logGroup: fn.logGroup, filterPattern: FilterPattern.literal(pattern), metricNamespace: namespace, metricName, metricValue: "1", defaultValue: 0 });
  fromLogs("FailedIntentsRunner", t.intentRunner, '{ $.event = "intent.failed" }', "FailedIntents");
  fromLogs("FailedIntentsSweep", t.sweep, '{ $.event = "intent.failed" }', "FailedIntents");
  fromLogs("SchedulerPasses", t.consumer, '{ $.event = "scheduler.pass" }', "SchedulerPasses");
  fromLogs("SweepIdle", t.sweep, '{ $.event = "sweep.no_active_runs" }', "SchedulerPasses");

  const metric = (metricName: string, period = Duration.minutes(1)) => new Metric({ namespace, metricName, statistic: "Sum", period });
  const alarm = (id: string, short: string, m: IMetric, o: { threshold: number; op?: ComparisonOperator; periods?: number; missing?: TreatMissingData; what: string }) =>
    new Alarm(scope, id, {
      alarmName: name(short),
      alarmDescription: o.what,
      metric: m,
      threshold: o.threshold,
      comparisonOperator: o.op ?? ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: o.periods ?? 1,
      treatMissingData: o.missing ?? TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(action);

  const dlqDepth = t.dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1), statistic: "Maximum" });
  const failed = metric("FailedIntents");
  const server5xx = t.api.metricServerError({ period: Duration.minutes(1), statistic: "Sum" });
  const consumerErrors = t.consumer.metricErrors({ period: Duration.minutes(1), statistic: "Sum" });
  const passes = metric("SchedulerPasses", Duration.minutes(3));

  alarm("DlqDepth", "dlq-depth", dlqDepth, { threshold: 0, what: "Work messages reached the dead-letter queue: an input failed five times." });
  alarm("FailedIntents", "failed-intents", failed, { threshold: 0, what: "An outside effect failed after its last try; see docs/runbook.md, recovering failed intents." });
  alarm("Ingress5xx", "ingress-5xx", server5xx, { threshold: 0, what: "The ingresses or the operator API answered 5xx; Rovara and GitHub will retry." });
  alarm("ConsumerErrors", "consumer-errors", consumerErrors, { threshold: 0, what: "The work consumer threw." });
  alarm("SchedulerStalled", "scheduler-stalled", passes, { threshold: 1, op: ComparisonOperator.LESS_THAN_THRESHOLD, missing: TreatMissingData.BREACHING, what: "No scheduling pass for 3 minutes: no scheduler lease was taken or renewed." });

  new Dashboard(scope, "Dashboard", {
    dashboardName: name("dashboard"),
    widgets: [
      [
        new GraphWidget({ title: "Dead-letter queue", left: [dlqDepth] }),
        new GraphWidget({ title: "Failed intents", left: [failed] }),
        new GraphWidget({ title: "API and ingress 5xx", left: [server5xx] }),
      ],
      [
        new GraphWidget({ title: "Work-consumer errors", left: [consumerErrors] }),
        new GraphWidget({ title: "Scheduler passes (3 min)", left: [passes] }),
        new GraphWidget({ title: "Queue depth", left: [t.dlq.metricApproximateNumberOfMessagesVisible()] }),
      ],
    ],
  });
  return topic;
}
