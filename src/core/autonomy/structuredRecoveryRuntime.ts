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
import { buildMissionCompletionContract } from "./missionContract";
import type { LoopbackTargetHint } from "./liveRunRecovery";
import type { ApprovedManagedProcessStartContext } from "./loopCleanupPolicy";
import {
  buildStructuredRecoveryExecutionPlan,
  evaluateStructuredRecoveryPolicy,
  type StructuredRecoveryExecutionStop
} from "../stage6_85/recovery";
import { extractActiveRequestSegment } from "../currentRequestExtraction";
import type { TaskRunResult } from "../types";

const RUNTIME_MANAGEMENT_VERB_PATTERN =
  /\b(?:inspect|check|confirm|verify|see\s+if|is\b|are\b|stop|shut\s*down|shutdown|close)\b/i;
const RUNTIME_MANAGEMENT_TARGET_PATTERN =
  /\b(?:running|run(?:ning)?|server|process|preview|browser|tab|window|session)\b/i;
const LIVE_LAUNCH_VERB_PATTERN =
  /\b(?:create|build|scaffold|generate|make|run|start|launch|serve|open|leave)\b/i;
const LIVE_LAUNCH_TARGET_PATTERN =
  /\b(?:nextjs|next\.js|vite|app|site|page|preview|browser|localhost|local(?:ly)?|server)\b/i;

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
  trackedManagedProcessStartContext: ApprovedManagedProcessStartContext | null;
  trackedLoopbackTarget: LoopbackTargetHint | null;
}): StructuredRecoveryRuntimeDecision {
  const activeRequestSegment = extractActiveRequestSegment(input.result.task.userInput);
  const recoverySnapshot = buildAutonomousRecoverySnapshot({
    result: input.result,
    missionContract: input.missionContract,
    missingRequirements: input.missingRequirements
  });
  const structuredRecoveryDecision = evaluateStructuredRecoveryPolicy({
    snapshot: recoverySnapshot,
    attemptCounts: input.attemptCounts
  });
  const activeRequestContract = buildMissionCompletionContract(
    activeRequestSegment
  );
  if (
    structuredRecoveryDecision.recoveryClass &&
    isManagedProcessReadinessRecoveryClass(structuredRecoveryDecision.recoveryClass) &&
    shouldSuppressManagedProcessReadinessRecovery(
      activeRequestSegment,
      input.missionContract,
      activeRequestContract
    )
  ) {
    return { outcome: "none" };
  }
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
    missionRequiresBrowserProof:
      input.missionContract.requireBrowserProof ||
      input.missionContract.requireBrowserOpenProof,
    result: input.result,
    decision: structuredRecoveryDecision,
    trackedManagedProcessLeaseId: input.trackedManagedProcessLeaseId,
    trackedManagedProcessStartContext: input.trackedManagedProcessStartContext,
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

/** Suppresses readiness retries when the active request is only about runtime inspection or shutdown. */
function shouldSuppressManagedProcessReadinessRecovery(
  activeRequestSegment: string,
  missionContract: MissionCompletionContract,
  activeRequestContract: MissionCompletionContract
): boolean {
  if (isExplicitRuntimeManagementOnlyRequest(activeRequestSegment)) {
    return true;
  }
  if (
    allowsManagedProcessReadinessRecovery(missionContract) ||
    allowsManagedProcessReadinessRecovery(activeRequestContract) ||
    appearsToRequestLiveLaunch(activeRequestSegment)
  ) {
    return false;
  }
  return true;
}

/** Evaluates whether either the mission or active request still requires live-run readiness proof. */
function allowsManagedProcessReadinessRecovery(
  missionContract: MissionCompletionContract
): boolean {
  return (
    missionContract.requireReadinessProof ||
    missionContract.requireBrowserProof ||
    missionContract.requireBrowserOpenProof
  );
}

/** Narrows recovery classes down to the bounded managed-process readiness family. */
function isManagedProcessReadinessRecoveryClass(
  recoveryClass: RecoveryFailureClass
): boolean {
  return (
    recoveryClass === "PROCESS_PORT_IN_USE" ||
    recoveryClass === "PROCESS_NOT_READY" ||
    recoveryClass === "TARGET_NOT_RUNNING"
  );
}

/** Detects runtime-management turns that should not be pulled back into build or launch recovery. */
function isExplicitRuntimeManagementOnlyRequest(activeRequestSegment: string): boolean {
  return (
    RUNTIME_MANAGEMENT_VERB_PATTERN.test(activeRequestSegment) &&
    RUNTIME_MANAGEMENT_TARGET_PATTERN.test(activeRequestSegment) &&
    !appearsToRequestLiveLaunch(activeRequestSegment)
  );
}

/** Detects whether the active request still appears to ask for a live app launch or preview. */
function appearsToRequestLiveLaunch(activeRequestSegment: string): boolean {
  return (
    LIVE_LAUNCH_VERB_PATTERN.test(activeRequestSegment) &&
    LIVE_LAUNCH_TARGET_PATTERN.test(activeRequestSegment)
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
