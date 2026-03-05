/**
 * @fileoverview Deterministic Stage 6.85 recovery-policy helpers for mission checkpoints, retry budgets, resume safety checks, and postmortem artifacts.
 */

import { MissionCheckpointV1, Stage675BlockCode } from "./types";

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

/**
 * Normalizes ordering and duplication for mission checkpoints.
 *
 * **Why it exists:**
 * Maintains stable ordering and deduplication rules for mission checkpoints in one place.
 *
 * **What it talks to:**
 * - Uses `MissionCheckpointV1` (import `MissionCheckpointV1`) from `./types`.
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
 * Resolves last durable checkpoint from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of last durable checkpoint by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `MissionCheckpointV1` (import `MissionCheckpointV1`) from `./types`.
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
 * Evaluates retry budget and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the retry budget policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
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
 * Evaluates resume safety and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the resume safety policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
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
 * Builds mission postmortem for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of mission postmortem consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `MissionCheckpointV1` (import `MissionCheckpointV1`) from `./types`.
 * - Uses `Stage675BlockCode` (import `Stage675BlockCode`) from `./types`.
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
