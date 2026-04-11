/**
 * @fileoverview Builds session-ledger-friendly autonomous execution results from loop iterations.
 */

import type { TaskRunResult } from "../core/types";
import type { ConversationExecutionResult } from "./conversationRuntime/managerContracts";

const GENERIC_AUTONOMOUS_OR_TASK_SUMMARY_PATTERNS = [
  /^autonomous task completed after\b/i,
  /^i started this, but (?:the run )?stopped before it finished\b/i,
  /^completed task with\b/i,
  /^completed\.?$/i,
  /^done\.?$/i,
  /^request completed\.?$/i
] as const;
const GENERIC_ACTION_OUTPUT_PATTERNS = [
  /^opened the page in (?:your|the) browser\.?$/i,
  /^opened .*browser window\.?$/i,
  /^closed the tracked browser window\.?$/i,
  /^closed .*browser window\.?$/i,
  /^verified browser expectations\.?$/i
] as const;

/**
 * Returns whether one summary string is too generic to stand on its own in the user-facing
 * autonomous terminal reply.
 *
 * @param value - Candidate summary text.
 * @returns `true` when the text is a generic wrapper rather than concrete execution evidence.
 */
function isGenericAutonomousOrTaskSummary(value: string): boolean {
  return GENERIC_AUTONOMOUS_OR_TASK_SUMMARY_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Derives a concise concrete autonomous outcome from a small set of approved action outputs when
 * the underlying task summary is generic.
 *
 * @param latestTaskRunResult - Latest concrete task result observed inside the loop.
 * @returns Concrete action-output summary, or `null` when the action set is too broad or generic.
 */
function deriveConcreteOutcomeFromApprovedActionOutputs(
  latestTaskRunResult: TaskRunResult
): string | null {
  const approvedOutputs = latestTaskRunResult.actionResults
    .flatMap((result) => {
      if (!result.approved || typeof result.output !== "string") {
        return [];
      }
      return [result.output.trim()];
    })
    .filter((output) => output.length > 0);
  const uniqueApprovedOutputs = [...new Set(approvedOutputs)];
  if (uniqueApprovedOutputs.length === 0 || uniqueApprovedOutputs.length > 3) {
    return null;
  }
  const concreteOutputs = uniqueApprovedOutputs.filter(
    (output) =>
      !isGenericAutonomousOrTaskSummary(output) &&
      !GENERIC_ACTION_OUTPUT_PATTERNS.some((pattern) => pattern.test(output))
  );
  if (concreteOutputs.length === 0) {
    return null;
  }
  return concreteOutputs.join("\n");
}

/**
 * Resolves the user-facing autonomous summary by appending the latest concrete task summary when
 * the generic loop wrapper would otherwise hide important execution evidence from the user.
 *
 * @param summary - Generic autonomous loop summary.
 * @param latestTaskRunResult - Latest concrete task result observed inside the loop.
 * @returns Final summary text for conversation delivery and persistence.
 */
function resolveAutonomousConversationSummary(
  summary: string,
  latestTaskRunResult: TaskRunResult | null
): string {
  const normalizedSummary = summary.trim();
  const latestTaskSummary = latestTaskRunResult?.summary?.trim() ?? "";
  const latestConcreteSummary = !isGenericAutonomousOrTaskSummary(latestTaskSummary)
    ? latestTaskSummary
    : latestTaskRunResult
    ? deriveConcreteOutcomeFromApprovedActionOutputs(latestTaskRunResult) ?? ""
    : "";
  if (!normalizedSummary || !latestConcreteSummary) {
    return summary;
  }
  if (normalizedSummary === latestConcreteSummary) {
    return summary;
  }
  if (isGenericAutonomousOrTaskSummary(latestConcreteSummary)) {
    return summary;
  }
  return `${summary}\n${latestConcreteSummary}`;
}

/**
 * Builds a conversation execution result for an autonomous loop by reusing the latest concrete
 * task result and replacing its summary/action history with the accumulated loop outcome.
 *
 * @param summary - Final user-facing autonomous summary.
 * @param latestTaskRunResult - Latest concrete task result observed inside the loop.
 * @param aggregatedActionResults - Aggregated action results from all loop iterations.
 * @param startedAt - Earliest observed task start timestamp.
 * @param completedAt - Latest observed task completion timestamp.
 * @returns Conversation execution result with a structured task result when available.
 */
export function buildAutonomousConversationExecutionResult(
  summary: string,
  latestTaskRunResult: TaskRunResult | null,
  aggregatedActionResults: TaskRunResult["actionResults"],
  startedAt: string | null,
  completedAt: string | null
): ConversationExecutionResult {
  const resolvedSummary = resolveAutonomousConversationSummary(summary, latestTaskRunResult);
  if (!latestTaskRunResult) {
    return { summary: resolvedSummary };
  }

  return {
    summary: resolvedSummary,
    taskRunResult: {
      ...latestTaskRunResult,
      summary: resolvedSummary,
      actionResults:
        aggregatedActionResults.length > 0
          ? [...aggregatedActionResults]
          : latestTaskRunResult.actionResults,
      startedAt: startedAt ?? latestTaskRunResult.startedAt,
      completedAt: completedAt ?? latestTaskRunResult.completedAt
    }
  };
}
