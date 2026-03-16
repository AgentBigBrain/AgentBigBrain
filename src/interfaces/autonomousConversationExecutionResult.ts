/**
 * @fileoverview Builds session-ledger-friendly autonomous execution results from loop iterations.
 */

import type { TaskRunResult } from "../core/types";
import type { ConversationExecutionResult } from "./conversationRuntime/managerContracts";

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
  if (!latestTaskRunResult) {
    return { summary };
  }

  return {
    summary,
    taskRunResult: {
      ...latestTaskRunResult,
      summary,
      actionResults:
        aggregatedActionResults.length > 0
          ? [...aggregatedActionResults]
          : latestTaskRunResult.actionResults,
      startedAt: startedAt ?? latestTaskRunResult.startedAt,
      completedAt: completedAt ?? latestTaskRunResult.completedAt
    }
  };
}
