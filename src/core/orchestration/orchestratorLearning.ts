/**
 * @fileoverview Canonical learning-signal persistence helpers for orchestrator task runs.
 */

import { type JudgmentPatternStore, deriveJudgmentPatternFromTaskRun } from "../judgmentPatterns";
import { type TaskRunResult } from "../types";
import { deriveWorkflowObservationFromTaskRun, type WorkflowLearningStore } from "../workflowLearningStore";

export interface PersistLearningSignalsDependencies {
  workflowLearningStore?: Pick<WorkflowLearningStore, "recordObservation">;
  judgmentPatternStore?: Pick<JudgmentPatternStore, "recordPattern" | "applyOutcomeSignal">;
}

/**
 * Derives deterministic objective-outcome score for judgment calibration.
 *
 * @param runResult - Completed task run result.
 * @returns Score in range [-1, 1] used for objective judgment signal writes.
 */
export function deriveJudgmentObjectiveScore(runResult: TaskRunResult): number {
  const totalActions = runResult.actionResults.length;
  if (totalActions <= 0) {
    return 0;
  }
  const approvedCount = runResult.actionResults.filter((result) => result.approved).length;
  const blockedCount = totalActions - approvedCount;
  return Number(((approvedCount - blockedCount) / totalActions).toFixed(4));
}

/**
 * Persists workflow and judgment learning signals from a completed run.
 *
 * @param deps - Learning-store dependencies used for post-run writes.
 * @param runResult - Completed task run used for learning writes.
 */
export async function persistLearningSignals(
  deps: PersistLearningSignalsDependencies,
  runResult: TaskRunResult
): Promise<void> {
  if (deps.workflowLearningStore) {
    try {
      const workflowObservation = deriveWorkflowObservationFromTaskRun(runResult);
      await deps.workflowLearningStore.recordObservation(workflowObservation);
    } catch (error) {
      console.error(
        `[WorkflowLearning] non-fatal observation persistence failure for task ${runResult.task.id}: ${(error as Error).message}`
      );
    }
  }

  if (deps.judgmentPatternStore) {
    try {
      const patternInput = deriveJudgmentPatternFromTaskRun(runResult, "balanced");
      const pattern = await deps.judgmentPatternStore.recordPattern(patternInput);
      await deps.judgmentPatternStore.applyOutcomeSignal(
        pattern.id,
        "objective",
        deriveJudgmentObjectiveScore(runResult),
        runResult.completedAt
      );
    } catch (error) {
      console.error(
        `[JudgmentPattern] non-fatal persistence failure for task ${runResult.task.id}: ${(error as Error).message}`
      );
    }
  }
}
