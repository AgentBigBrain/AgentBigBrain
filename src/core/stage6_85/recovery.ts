/**
 * @fileoverview Canonical Stage 6.85 recovery-policy helpers for checkpoint ordering, retry budgets, resume safety, and mission postmortems.
 */

import { MissionCheckpointV1, Stage675BlockCode } from "../types";
import {
  MAX_MANAGED_PROCESS_READINESS_FAILURES,
  type AutonomousRecoverySnapshot,
  type RecoveryFailureClass,
  type RecoveryFailureSignal,
  type RecoveryRung
} from "../autonomy/contracts";
export type {
  StructuredRecoveryExecutionPlan,
  StructuredRecoveryExecutionStop
} from "./structuredRecoveryExecution";
export {
  buildStructuredRecoveryExecutionPlan,
  isStructuredRecoveryInstruction
} from "./structuredRecoveryExecution";

export interface RetryBudgetDecision {
  shouldRetry: boolean;
  nextAttempt: number;
  blockCode: Stage675BlockCode | null;
  reason: string;
}

export interface ResumeSafetyDecision {
  allowed: boolean;
  blockCode: Stage675BlockCode | null;
  reason: string;
}

export interface MissionPostmortemV1 {
  missionId: string;
  missionAttemptId: number;
  failedAt: string;
  blockCode: Stage675BlockCode;
  rootCause: string;
  lastDurableCheckpoint: MissionCheckpointV1 | null;
  remediationSteps: readonly string[];
}

export interface StructuredRecoveryPolicyDecision {
  outcome: "none" | "attempt_repair" | "stop";
  recoveryClass: RecoveryFailureClass | null;
  allowedRung: RecoveryRung | null;
  optionId: string | null;
  fingerprint: string | null;
  attemptsUsed: number;
  maxAttempts: number | null;
  cooldownIterations: number;
  builderPending: boolean;
  reason: string;
}

interface RecoveryPolicyRule {
  optionId: string;
  allowedRung: RecoveryRung;
  maxAttempts: number;
  cooldownIterations: number;
  builderPending: boolean;
  stopReason: string;
  retryReason: string;
}

const RECOVERY_POLICY_RULES: Record<RecoveryFailureClass, RecoveryPolicyRule | null> = {
  EXECUTABLE_NOT_FOUND: {
    optionId: "resolve_known_executable",
    allowedRung: "executor_native_adaptation",
    maxAttempts: 0,
    cooldownIterations: 0,
    builderPending: false,
    stopReason:
      "Executable resolution is an executor-native repair. If this class still surfaced, the bounded native adaptation path is already exhausted for this run.",
    retryReason: "Retry only when the executor has a deterministic alternate executable."
  },
  COMMAND_TOO_LONG: {
    optionId: "stage_command_via_script",
    allowedRung: "executor_native_adaptation",
    maxAttempts: 0,
    cooldownIterations: 0,
    builderPending: false,
    stopReason:
      "Oversized-command staging is an executor-native repair. If this class still surfaced, the native staging path is already exhausted for this run.",
    retryReason: "Retry only when the executor can stage the command through a deterministic temp script."
  },
  DEPENDENCY_MISSING: {
    optionId: "repair_missing_dependency",
    allowedRung: "bounded_repair_iteration",
    maxAttempts: 1,
    cooldownIterations: 0,
    builderPending: true,
    stopReason:
      "The deterministic missing-dependency repair budget is exhausted for this run.",
    retryReason:
      "One bounded dependency-repair iteration is allowed when the missing dependency is identified deterministically."
  },
  VERSION_INCOMPATIBLE: {
    optionId: "align_dependency_version",
    allowedRung: "bounded_repair_iteration",
    maxAttempts: 1,
    cooldownIterations: 0,
    builderPending: true,
    stopReason:
      "The deterministic version-alignment repair budget is exhausted for this run.",
    retryReason:
      "One bounded version-alignment iteration is allowed when the incompatible dependency is identified deterministically."
  },
  PROCESS_PORT_IN_USE: {
    optionId: "retry_with_alternate_port",
    allowedRung: "bounded_repair_iteration",
    maxAttempts: 1,
    cooldownIterations: 0,
    builderPending: false,
    stopReason:
      "The deterministic alternate-port repair budget is exhausted for this run.",
    retryReason:
      "One bounded alternate-port restart is allowed when the conflicting localhost port is identified deterministically."
  },
  PROCESS_NOT_READY: {
    optionId: "retry_readiness_proof",
    allowedRung: "same_iteration_typed_continuation",
    maxAttempts: MAX_MANAGED_PROCESS_READINESS_FAILURES,
    cooldownIterations: 0,
    builderPending: false,
    stopReason:
      "The deterministic readiness-check continuation budget is exhausted for this run.",
    retryReason:
      "One typed readiness-continuation step is allowed before falling back to broader loop policy."
  },
  TARGET_NOT_RUNNING: {
    optionId: "restart_target_then_reverify",
    allowedRung: "bounded_repair_iteration",
    maxAttempts: 1,
    cooldownIterations: 0,
    builderPending: false,
    stopReason:
      "The deterministic restart-and-reverify budget is exhausted for this run.",
    retryReason:
      "One bounded restart-and-reverify iteration is allowed when the tracked target stopped unexpectedly."
  },
  AUTH_NOT_INITIALIZED: null,
  REMOTE_RATE_LIMITED: null,
  REMOTE_UNAVAILABLE: null,
  BROWSER_START_BLOCKED: null,
  WORKSPACE_HOLDER_CONFLICT: null,
  TRANSCRIPTION_BACKEND_UNAVAILABLE: null,
  UNKNOWN_EXECUTION_FAILURE: null
};

/**
 * Normalizes ordering for mission checkpoints.
 *
 * @param checkpoints - Value for checkpoints.
 * @returns Ordered collection produced by this step.
 */
export function sortMissionCheckpoints(
  checkpoints: readonly MissionCheckpointV1[]
): MissionCheckpointV1[] {
  return [...checkpoints].sort((left, right) => {
    if (left.missionAttemptId !== right.missionAttemptId) {
      return left.missionAttemptId - right.missionAttemptId;
    }
    if (left.observedAt !== right.observedAt) {
      return left.observedAt.localeCompare(right.observedAt);
    }
    return left.actionId.localeCompare(right.actionId);
  });
}

/**
 * Resolves the last durable checkpoint from deterministic checkpoint ordering.
 *
 * @param checkpoints - Value for checkpoints.
 * @returns Computed `MissionCheckpointV1 | null` result.
 */
export function resolveLastDurableCheckpoint(
  checkpoints: readonly MissionCheckpointV1[]
): MissionCheckpointV1 | null {
  const sorted = sortMissionCheckpoints(checkpoints);
  if (sorted.length === 0) {
    return null;
  }
  return sorted[sorted.length - 1] ?? null;
}

/**
 * Evaluates retry budget constraints.
 *
 * @param currentAttempt - Value for current attempt.
 * @param maxAttempts - Numeric bound, counter, or index used by this logic.
 * @returns Computed `RetryBudgetDecision` result.
 */
export function evaluateRetryBudget(
  currentAttempt: number,
  maxAttempts: number
): RetryBudgetDecision {
  if (!Number.isInteger(currentAttempt) || currentAttempt <= 0) {
    return {
      shouldRetry: false,
      nextAttempt: currentAttempt,
      blockCode: "MISSION_STOP_LIMIT_REACHED",
      reason: "Current attempt is invalid; retry budget evaluation failed closed."
    };
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
    return {
      shouldRetry: false,
      nextAttempt: currentAttempt,
      blockCode: "MISSION_STOP_LIMIT_REACHED",
      reason: "Max attempt budget is invalid; retry budget evaluation failed closed."
    };
  }
  if (currentAttempt >= maxAttempts) {
    return {
      shouldRetry: false,
      nextAttempt: currentAttempt,
      blockCode: "MISSION_STOP_LIMIT_REACHED",
      reason: "Mission retry budget exhausted."
    };
  }
  return {
    shouldRetry: true,
    nextAttempt: currentAttempt + 1,
    blockCode: null,
    reason: "Retry budget allows deterministic next attempt."
  };
}

/**
 * Builds one deterministic fingerprint for recovery-attempt budgeting.
 *
 * @param signal - Recovery signal chosen for the next recovery policy decision.
 * @param optionId - Selected recovery option identifier.
 * @returns Stable recovery-attempt fingerprint.
 */
export function buildRecoveryAttemptFingerprint(
  signal: RecoveryFailureSignal,
  optionId: string
): string {
  return [
    signal.recoveryClass,
    optionId,
    signal.provenance,
    signal.realm ?? "",
    signal.sourceCode ?? ""
  ].join("|");
}

/**
 * Evaluates bounded recovery policy for the current structured recovery snapshot.
 *
 * @param snapshot - Structured recovery snapshot derived from the latest task result.
 * @param attemptCounts - Previously consumed recovery-attempt counts keyed by fingerprint.
 * @returns Canonical recovery-policy decision for the current loop step.
 */
export function evaluateStructuredRecoveryPolicy(input: {
  snapshot: AutonomousRecoverySnapshot;
  attemptCounts: ReadonlyMap<string, number>;
}): StructuredRecoveryPolicyDecision {
  const primarySignal = input.snapshot.failureSignals[0] ?? null;
  if (!primarySignal) {
    return {
      outcome: "none",
      recoveryClass: null,
      allowedRung: null,
      optionId: null,
      fingerprint: null,
      attemptsUsed: 0,
      maxAttempts: null,
      cooldownIterations: 0,
      builderPending: false,
      reason: "No structured recovery signal is present."
    };
  }

  const rule = RECOVERY_POLICY_RULES[primarySignal.recoveryClass];
  if (!rule) {
    return {
      outcome: "none",
      recoveryClass: primarySignal.recoveryClass,
      allowedRung: null,
      optionId: null,
      fingerprint: null,
      attemptsUsed: 0,
      maxAttempts: null,
      cooldownIterations: 0,
      builderPending: false,
      reason: "No bounded recovery contract exists yet for this recovery class."
    };
  }

  const option = input.snapshot.repairOptions.find(
    (candidate) => candidate.optionId === rule.optionId
  );
  if (!option) {
    return {
      outcome: "stop",
      recoveryClass: primarySignal.recoveryClass,
      allowedRung: rule.allowedRung,
      optionId: rule.optionId,
      fingerprint: buildRecoveryAttemptFingerprint(primarySignal, rule.optionId),
      attemptsUsed: 0,
      maxAttempts: rule.maxAttempts,
      cooldownIterations: rule.cooldownIterations,
      builderPending: rule.builderPending,
      reason: `The recovery snapshot did not expose the expected bounded repair option ${rule.optionId}.`
    };
  }

  const fingerprint = buildRecoveryAttemptFingerprint(primarySignal, rule.optionId);
  const attemptsUsed = input.attemptCounts.get(fingerprint) ?? 0;
  if (rule.maxAttempts <= 0) {
    return {
      outcome: "stop",
      recoveryClass: primarySignal.recoveryClass,
      allowedRung: rule.allowedRung,
      optionId: rule.optionId,
      fingerprint,
      attemptsUsed,
      maxAttempts: rule.maxAttempts,
      cooldownIterations: rule.cooldownIterations,
      builderPending: rule.builderPending,
      reason: rule.stopReason
    };
  }

  if (attemptsUsed >= rule.maxAttempts) {
    return {
      outcome: "stop",
      recoveryClass: primarySignal.recoveryClass,
      allowedRung: rule.allowedRung,
      optionId: rule.optionId,
      fingerprint,
      attemptsUsed,
      maxAttempts: rule.maxAttempts,
      cooldownIterations: rule.cooldownIterations,
      builderPending: rule.builderPending,
      reason: rule.stopReason
    };
  }

  return {
    outcome: "attempt_repair",
    recoveryClass: primarySignal.recoveryClass,
    allowedRung: rule.allowedRung,
    optionId: rule.optionId,
    fingerprint,
    attemptsUsed,
    maxAttempts: rule.maxAttempts,
    cooldownIterations: rule.cooldownIterations,
    builderPending: rule.builderPending,
    reason: rule.retryReason
  };
}

/**
 * Reads one trimmed string param from an action result when present.
 *
 * @param result - Executed action result entry.
 * @param key - Param key to read.
 * @returns Trimmed string value, or `null`.
 */
/**
 * Evaluates deterministic resume safety constraints.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `ResumeSafetyDecision` result.
 */
export function evaluateResumeSafety(input: {
  approvalUses: number;
  approvalMaxUses: number;
  freshnessValid: boolean;
  diffHashMatches: boolean;
}): ResumeSafetyDecision {
  if (input.approvalUses >= input.approvalMaxUses) {
    return {
      allowed: false,
      blockCode: "APPROVAL_MAX_USES_EXCEEDED",
      reason: "Resume cannot reuse approval beyond maxUses."
    };
  }
  if (!input.freshnessValid) {
    return {
      allowed: false,
      blockCode: "STATE_STALE_REPLAN_REQUIRED",
      reason: "Resume failed freshness validation."
    };
  }
  if (!input.diffHashMatches) {
    return {
      allowed: false,
      blockCode: "APPROVAL_DIFF_HASH_MISMATCH",
      reason: "Resume failed diff-hash validation."
    };
  }
  return {
    allowed: true,
    blockCode: null,
    reason: "Resume safety checks passed."
  };
}

/**
 * Builds a deterministic mission postmortem artifact.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `MissionPostmortemV1` result.
 */
export function buildMissionPostmortem(input: {
  missionId: string;
  missionAttemptId: number;
  failedAt: string;
  blockCode: Stage675BlockCode;
  rootCause: string;
  checkpoints: readonly MissionCheckpointV1[];
}): MissionPostmortemV1 {
  return {
    missionId: input.missionId,
    missionAttemptId: input.missionAttemptId,
    failedAt: input.failedAt,
    blockCode: input.blockCode,
    rootCause: input.rootCause,
    lastDurableCheckpoint: resolveLastDurableCheckpoint(input.checkpoints),
    remediationSteps: [
      "Re-read mission state and regenerate pending plan from last durable checkpoint.",
      "Re-validate approval freshness and diff hash before side effects.",
      "Resume only after deterministic constraints and governance path pass."
    ]
  };
}
