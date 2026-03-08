/**
 * @fileoverview Mission checkpoint, postmortem, and failure-taxonomy helpers for the orchestrator.
 */

import {
  type ActionRunResult,
  type FailureTaxonomyCodeV1,
  type FailureTaxonomyResultV1,
  type MissionCheckpointV1,
  STAGE_6_75_BLOCK_CODES,
  type Stage675BlockCode,
  type TaskRunResult
} from "../types";
import {
  buildFailureTaxonomySignalFromRun,
  classifyFailureTaxonomy
} from "../advancedAutonomyFoundation";
import { type RetryBudgetDecision } from "../stage6_85RecoveryPolicy";

/**
 * Evaluates stage675 block code and returns a deterministic policy signal.
 *
 * @param value - Candidate block code from violations, blocked-by lists, or retry policy.
 * @returns `true` when value is one of the Stage 6.75 canonical block codes.
 */
export function isStage675BlockCode(value: unknown): value is Stage675BlockCode {
  return (
    typeof value === "string" &&
    STAGE_6_75_BLOCK_CODES.includes(value as Stage675BlockCode)
  );
}

/**
 * Creates a mission-checkpoint record for one executed plan action.
 *
 * @param taskId - Parent task/mission id.
 * @param missionAttemptId - Replan attempt number associated with this action.
 * @param result - Action execution/governance result.
 * @param checkpointIndex - Monotonic checkpoint index across all attempts.
 * @param observedAtIso - Timestamp captured when checkpoint entries are emitted.
 * @returns Mission checkpoint entry with stable idempotency key.
 */
export function buildMissionCheckpoint(
  taskId: string,
  missionAttemptId: number,
  result: ActionRunResult,
  checkpointIndex: number,
  observedAtIso: string
): MissionCheckpointV1 {
  return {
    missionId: taskId,
    missionAttemptId,
    phase: "verify",
    actionType: result.action.type,
    observedAt: observedAtIso,
    idempotencyKey: `${taskId}:${missionAttemptId}:${result.action.id}:${checkpointIndex}`,
    actionId: result.action.id
  };
}

/**
 * Resolves mission failure block code from available runtime context.
 *
 * @param actionResults - Action outcomes collected across executed attempts.
 * @param retryDecision - Retry-budget decision for the last attempt, when available.
 * @returns Canonical Stage 6.75 block code describing why execution stopped.
 */
export function resolveMissionFailureBlockCode(
  actionResults: readonly ActionRunResult[],
  retryDecision: RetryBudgetDecision | null
): Stage675BlockCode {
  if (retryDecision && !retryDecision.shouldRetry && retryDecision.blockCode) {
    return retryDecision.blockCode;
  }

  for (const result of actionResults) {
    for (const code of result.blockedBy) {
      if (isStage675BlockCode(code)) {
        return code;
      }
    }
    for (const violation of result.violations) {
      if (isStage675BlockCode(violation.code)) {
        return violation.code;
      }
    }
  }

  return "MISSION_STOP_LIMIT_REACHED";
}

/**
 * Resolves mission failure root cause from available runtime context.
 *
 * @param actionResults - Action outcomes collected across executed attempts.
 * @param retryDecision - Retry-budget decision for the last attempt, when available.
 * @returns Human-readable cause summary for postmortem output.
 */
export function resolveMissionFailureRootCause(
  actionResults: readonly ActionRunResult[],
  retryDecision: RetryBudgetDecision | null
): string {
  if (retryDecision && !retryDecision.shouldRetry) {
    return retryDecision.reason;
  }

  const firstBlocked = actionResults.find((result) => !result.approved);
  if (!firstBlocked) {
    return "No blocked action details were recorded.";
  }

  if (firstBlocked.violations.length > 0) {
    return firstBlocked.violations[0]?.message ?? "Constraint policy blocked execution.";
  }

  const rejectVotes = firstBlocked.votes.filter((vote) => !vote.approve);
  if (rejectVotes.length > 0) {
    return rejectVotes[0]?.reason ?? "Governance policy blocked execution.";
  }

  return "Mission stopped after deterministic runtime safety checks.";
}

/**
 * Decides whether to emit a Stage 6.85 mission postmortem in the task summary.
 *
 * @param actionResults - Action outcomes collected across executed attempts.
 * @param retryDecision - Retry-budget decision for the last attempt, when available.
 * @returns `true` when summary output should include mission postmortem details.
 */
export function shouldEmitMissionPostmortem(
  actionResults: readonly ActionRunResult[],
  retryDecision: RetryBudgetDecision | null
): boolean {
  if (retryDecision && !retryDecision.shouldRetry) {
    return true;
  }

  return actionResults.some((result) =>
    result.blockedBy.some((code) => isStage675BlockCode(code)) ||
    result.violations.some((violation) => isStage675BlockCode(violation.code))
  );
}

/**
 * Resolves deterministic FailureTaxonomyCodeV1 from failure category output.
 *
 * @param category - Classified failure taxonomy category.
 * @returns Canonical failure taxonomy code.
 */
export function mapFailureTaxonomyCode(
  category: FailureTaxonomyResultV1["failureCategory"]
): FailureTaxonomyCodeV1 {
  if (category === "constraint") {
    return "constraint_blocked";
  }
  if (category === "objective") {
    return "objective_not_met";
  }
  if (category === "reasoning") {
    return "reasoning_planner_failed";
  }
  if (category === "human_feedback") {
    return "human_feedback_required";
  }
  return "quality_rejected";
}

/**
 * Derives typed failure taxonomy metadata for a completed run result when applicable.
 *
 * @param runResult - Completed task run result to classify.
 * @returns Typed taxonomy metadata, or null when run has no failure signal.
 */
export function deriveFailureTaxonomyFromRun(
  runResult: TaskRunResult
): FailureTaxonomyResultV1 | null {
  const approvedCount = runResult.actionResults.filter((result) => result.approved).length;
  const blockedCount = runResult.actionResults.length - approvedCount;
  if (blockedCount === 0 && approvedCount > 0) {
    return null;
  }

  const failureCategory = classifyFailureTaxonomy(buildFailureTaxonomySignalFromRun(runResult));
  return {
    failureCategory,
    failureCode: mapFailureTaxonomyCode(failureCategory)
  };
}
