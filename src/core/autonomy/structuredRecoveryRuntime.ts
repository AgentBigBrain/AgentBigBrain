/**
 * @fileoverview Loop-level structured recovery resolution for bounded autonomous repair steps.
 */

import {
  buildAutonomousRecoverySnapshot,
  TASK_EXECUTION_FAILED_REASON_CODE,
  formatReasonWithCode,
  type MissionCompletionContract,
  type MissionRequirementId,
  type RecoveryFailureClass
} from "./contracts";
import { buildStructuredRecoveryStateMessage } from "./agentLoopProgress";
import type { LoopbackTargetHint } from "./liveRunRecovery";
import {
  buildStructuredRecoveryExecutionPlan,
  evaluateStructuredRecoveryPolicy,
  type StructuredRecoveryExecutionStop
} from "../stage6_85/recovery";
import type { TaskRunResult } from "../types";

export type StructuredRecoveryRuntimeDecision =
  | { outcome: "none" }
  | {
      outcome: "retry";
      recoveryClass: RecoveryFailureClass;
      fingerprint: string;
      reasoning: string;
      progressMessage: string;
      nextUserInput: string;
    }
  | {
      outcome: "abort";
      cleanupManagedProcess: boolean;
      reason: string;
    };

/**
 * Resolves one loop-level structured recovery action from the latest task result and proof gaps.
 *
 * @param input - Current goal, task result, proof state, tracked runtime state, and repair counts.
 * @returns Retry instruction, bounded abort, or `none` when no structured recovery applies.
 */
export function resolveStructuredRecoveryRuntimeDecision(input: {
  overarchingGoal: string;
  missionContract: MissionCompletionContract;
  missingRequirements: readonly MissionRequirementId[];
  result: TaskRunResult;
  attemptCounts: ReadonlyMap<string, number>;
  trackedManagedProcessLeaseId: string | null;
  trackedLoopbackTarget: LoopbackTargetHint | null;
}): StructuredRecoveryRuntimeDecision {
  const recoverySnapshot = buildAutonomousRecoverySnapshot({
    result: input.result,
    missionContract: input.missionContract,
    missingRequirements: input.missingRequirements
  });
  const structuredRecoveryDecision = evaluateStructuredRecoveryPolicy({
    snapshot: recoverySnapshot,
    attemptCounts: input.attemptCounts
  });
  if (structuredRecoveryDecision.outcome === "stop") {
    return {
      outcome: "abort",
      cleanupManagedProcess: shouldCleanupManagedProcessForRecoveryClass(
        structuredRecoveryDecision.recoveryClass
      ),
      reason: formatReasonWithCode(
        TASK_EXECUTION_FAILED_REASON_CODE,
        `Deterministic recovery stopped for ${structuredRecoveryDecision.recoveryClass ?? "UNKNOWN_EXECUTION_FAILURE"}: ${structuredRecoveryDecision.reason}`
      )
    };
  }
  if (structuredRecoveryDecision.outcome !== "attempt_repair") {
    return { outcome: "none" };
  }

  const structuredRecoveryPlan = buildStructuredRecoveryExecutionPlan({
    overarchingGoal: input.overarchingGoal,
    missionRequiresBrowserProof: input.missionContract.requireBrowserProof,
    result: input.result,
    decision: structuredRecoveryDecision,
    trackedManagedProcessLeaseId: input.trackedManagedProcessLeaseId,
    trackedLoopbackTarget: input.trackedLoopbackTarget
  });
  if (!structuredRecoveryPlan) {
    return { outcome: "none" };
  }
  if (isStructuredRecoveryExecutionStop(structuredRecoveryPlan)) {
    return {
      outcome: "abort",
      cleanupManagedProcess: shouldCleanupManagedProcessForRecoveryClass(
        structuredRecoveryPlan.recoveryClass
      ),
      reason: formatReasonWithCode(
        TASK_EXECUTION_FAILED_REASON_CODE,
        `Deterministic recovery failed closed for ${structuredRecoveryPlan.recoveryClass}: ${structuredRecoveryPlan.reason}`
      )
    };
  }

  return {
    outcome: "retry",
    recoveryClass: structuredRecoveryPlan.recoveryClass,
    fingerprint: structuredRecoveryPlan.fingerprint,
    reasoning: structuredRecoveryPlan.reasoning,
    progressMessage:
      structuredRecoveryPlan.progressMessage ||
      buildStructuredRecoveryStateMessage(structuredRecoveryPlan.recoveryClass),
    nextUserInput: structuredRecoveryPlan.nextUserInput
  };
}

/**
 * Decides whether a bounded recovery abort should clean up the tracked managed process.
 *
 * @param recoveryClass - Recovery class attached to the abort.
 * @returns `true` when cleanup is required.
 */
function shouldCleanupManagedProcessForRecoveryClass(
  recoveryClass: RecoveryFailureClass | null
): boolean {
  return (
    recoveryClass === "PROCESS_PORT_IN_USE" ||
    recoveryClass === "PROCESS_NOT_READY" ||
    recoveryClass === "TARGET_NOT_RUNNING"
  );
}

/**
 * Narrows a structured recovery builder result into the fail-closed stop shape.
 *
 * @param value - Builder result to inspect.
 * @returns `true` when the builder returned a stop object.
 */
function isStructuredRecoveryExecutionStop(
  value: ReturnType<typeof buildStructuredRecoveryExecutionPlan>
): value is StructuredRecoveryExecutionStop {
  return Boolean(value && "reason" in value && !("nextUserInput" in value));
}
