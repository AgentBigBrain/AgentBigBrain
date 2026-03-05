/**
 * @fileoverview Evaluates deterministic spawn policy for controlled subagent delegation decisions.
 */

import {
  SubagentDelegationDecision,
  SubagentDelegationLimits,
  SubagentDelegationSignal
} from "./types";

const WEIGHTS = {
  capabilityGap: 0.4,
  parallelGain: 0.25,
  riskReduction: 0.25,
  budgetPressure: -0.3
} as const;

const SCORE_PRECISION = 4;

/**
 * Constrains and sanitizes unit to safe deterministic bounds.
 *
 * **Why it exists:**
 * Enforces consistent bounds/sanitization for unit before data flows to policy checks.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed numeric value.
 */
function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

/**
 * Converts values into rounded score form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for rounded score deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed numeric value.
 */
function toRoundedScore(value: number): number {
  return Number(value.toFixed(SCORE_PRECISION));
}

/**
 * Builds limit blocks for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of limit blocks consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `SubagentDelegationLimits` (import `SubagentDelegationLimits`) from `./types`.
 * - Uses `SubagentDelegationSignal` (import `SubagentDelegationSignal`) from `./types`.
 *
 * @param signal - Value for signal.
 * @param limits - Numeric bound, counter, or index used by this logic.
 * @returns Ordered collection produced by this step.
 */
function buildLimitBlocks(
  signal: SubagentDelegationSignal,
  limits: SubagentDelegationLimits
): string[] {
  const blockedBy: string[] = [];

  if (signal.currentSubagentCount >= limits.maxSubagentsPerTask) {
    blockedBy.push("SUBAGENT_LIMIT_REACHED");
  }
  if (signal.requestedDepth > limits.maxSubagentDepth) {
    blockedBy.push("SUBAGENT_DEPTH_EXCEEDED");
  }
  if (signal.requiresEscalationApproval) {
    blockedBy.push("REQUIRES_ESCALATION_VOTE");
  }

  return blockedBy;
}

/**
 * Builds reasons for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of reasons consistent across call sites.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param spawnScore - Value for spawn score.
 * @param threshold - Value for threshold.
 * @returns Ordered collection produced by this step.
 */
function buildReasons(spawnScore: number, threshold: number): string[] {
  if (spawnScore >= threshold) {
    return [
      `Spawn score ${spawnScore.toFixed(2)} met threshold ${threshold.toFixed(2)}.`,
      "Delegation appears beneficial under current deterministic policy."
    ];
  }

  return [
    `Spawn score ${spawnScore.toFixed(2)} is below threshold ${threshold.toFixed(2)}.`,
    "Continue execution in current organ unless conditions improve."
  ];
}

/**
 * Evaluates subagent delegation and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the subagent delegation policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `SubagentDelegationDecision` (import `SubagentDelegationDecision`) from `./types`.
 * - Uses `SubagentDelegationLimits` (import `SubagentDelegationLimits`) from `./types`.
 * - Uses `SubagentDelegationSignal` (import `SubagentDelegationSignal`) from `./types`.
 *
 * @param signal - Value for signal.
 * @param limits - Numeric bound, counter, or index used by this logic.
 * @returns Computed `SubagentDelegationDecision` result.
 */
export function evaluateSubagentDelegation(
  signal: SubagentDelegationSignal,
  limits: SubagentDelegationLimits
): SubagentDelegationDecision {
  const blockedBy = buildLimitBlocks(signal, limits);
  const spawnScore = toRoundedScore(
    clampUnit(signal.capabilityGapScore) * WEIGHTS.capabilityGap +
      clampUnit(signal.parallelGainScore) * WEIGHTS.parallelGain +
      clampUnit(signal.riskReductionScore) * WEIGHTS.riskReduction +
      clampUnit(signal.budgetPressureScore) * WEIGHTS.budgetPressure
  );

  if (blockedBy.length > 0) {
    return {
      shouldSpawn: false,
      spawnScore,
      blockedBy,
      reasons: blockedBy.map((block) => `Delegation blocked by ${block}.`)
    };
  }

  const threshold = clampUnit(limits.spawnThresholdScore);
  return {
    shouldSpawn: spawnScore >= threshold,
    spawnScore,
    blockedBy: [],
    reasons: buildReasons(spawnScore, threshold)
  };
}
