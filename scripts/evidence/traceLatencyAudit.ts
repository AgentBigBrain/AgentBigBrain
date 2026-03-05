/**
 * @fileoverview Computes deterministic runtime-trace latency and correlation summaries for Stage 6.5 observability evidence.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createBrainConfigFromEnv } from "../../src/core/config";
import { RuntimeTraceEvent } from "../../src/core/types";
import { RuntimeTraceLogger } from "../../src/core/runtimeTraceLogger";

const DEFAULT_OUTPUT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_5_trace_latency_audit.json"
);

interface LatencySummary {
  count: number;
  minMs: number | null;
  maxMs: number | null;
  averageMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
}

interface TraceLatencyAuditReport {
  generatedAt: string;
  traceLogPath: string;
  totalEvents: number;
  eventTypeCounts: Record<string, number>;
  correlation: {
    taskLinkedEvents: number;
    actionLinkedEvents: number;
    governancePersistedEvents: number;
    governanceEventsWithCorrelationId: number;
  };
  spans: {
    planner: LatencySummary;
    governance: LatencySummary;
    executor: LatencySummary;
    taskTotal: LatencySummary;
  };
}

/**
 * Implements `computePercentile` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function computePercentile(sortedValues: readonly number[], percentile: number): number | null {
  if (sortedValues.length === 0) {
    return null;
  }
  if (sortedValues.length === 1) {
    return sortedValues[0];
  }

  const normalizedPercentile = Math.min(100, Math.max(0, percentile));
  const index = Math.ceil((normalizedPercentile / 100) * sortedValues.length) - 1;
  return sortedValues[Math.min(sortedValues.length - 1, Math.max(0, index))];
}

/**
 * Implements `buildLatencySummary` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildLatencySummary(values: readonly number[]): LatencySummary {
  if (values.length === 0) {
    return {
      count: 0,
      minMs: null,
      maxMs: null,
      averageMs: null,
      p50Ms: null,
      p95Ms: null
    };
  }

  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    averageMs: Number((sum / sorted.length).toFixed(2)),
    p50Ms: computePercentile(sorted, 50),
    p95Ms: computePercentile(sorted, 95)
  };
}

/**
 * Implements `toDurationArray` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function toDurationArray(events: readonly RuntimeTraceEvent[]): number[] {
  return events
    .map((event) => event.durationMs)
    .filter((durationMs): durationMs is number => typeof durationMs === "number");
}

/**
 * Implements `buildEventTypeCounts` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildEventTypeCounts(events: readonly RuntimeTraceEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    counts[event.eventType] = (counts[event.eventType] ?? 0) + 1;
  }
  return counts;
}

/**
 * Implements `buildTraceLatencyAuditReport` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildTraceLatencyAuditReport(
  events: readonly RuntimeTraceEvent[],
  traceLogPath: string
): TraceLatencyAuditReport {
  const plannerDurations = toDurationArray(
    events.filter((event) => event.eventType === "planner_completed")
  );
  const governanceDurations = toDurationArray(
    events.filter((event) => event.eventType === "governance_voted")
  );
  const executionDurations = toDurationArray(
    events.filter((event) => event.eventType === "action_executed")
  );
  const taskDurations = toDurationArray(
    events.filter((event) => event.eventType === "task_completed")
  );

  const governancePersistedEvents = events.filter(
    (event) => event.eventType === "governance_event_persisted"
  );

  return {
    generatedAt: new Date().toISOString(),
    traceLogPath,
    totalEvents: events.length,
    eventTypeCounts: buildEventTypeCounts(events),
    correlation: {
      taskLinkedEvents: events.filter((event) => event.taskId.trim().length > 0).length,
      actionLinkedEvents: events.filter(
        (event) => typeof event.actionId === "string" && event.actionId.trim().length > 0
      ).length,
      governancePersistedEvents: governancePersistedEvents.length,
      governanceEventsWithCorrelationId: governancePersistedEvents.filter(
        (event) =>
          typeof event.governanceEventId === "string" &&
          event.governanceEventId.trim().length > 0
      ).length
    },
    spans: {
      planner: buildLatencySummary(plannerDurations),
      governance: buildLatencySummary(governanceDurations),
      executor: buildLatencySummary(executionDurations),
      taskTotal: buildLatencySummary(taskDurations)
    }
  };
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const config = createBrainConfigFromEnv();
  const logger = new RuntimeTraceLogger({
    enabled: config.observability.traceEnabled,
    filePath: config.observability.traceLogPath
  });
  const events = await logger.readEvents();
  const report = buildTraceLatencyAuditReport(events, config.observability.traceLogPath);
  const outputPath = process.env.BRAIN_TRACE_AUDIT_OUTPUT_PATH?.trim() || DEFAULT_OUTPUT_PATH;

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");

  console.log(`Runtime trace audit generated: ${outputPath}`);
  console.log(`Trace source path: ${config.observability.traceLogPath}`);
  console.log(`Trace events analyzed: ${report.totalEvents}`);
  console.log(
    `Task latency p50/p95 (ms): ${report.spans.taskTotal.p50Ms ?? "n/a"}/${report.spans.taskTotal.p95Ms ?? "n/a"}`
  );
}

void main();

