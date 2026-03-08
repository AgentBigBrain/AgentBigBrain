/**
 * @fileoverview Canonical Stage 6.85 latency-policy helpers for phase budgets, cache-equivalence checks, and deterministic reject summaries.
 */

import { toSortedUnique } from "../cryptoUtils";

export type MissionLatencyPhaseV1 =
  | "planning"
  | "vote_collection"
  | "execution"
  | "response_rendering";

export type MissionPhaseLatencyBudgetV1 = Record<MissionLatencyPhaseV1, number>;

export interface PhaseLatencyEvaluation {
  phase: MissionLatencyPhaseV1;
  observedMs: number;
  budgetMs: number;
  passed: boolean;
}

/**
 * Resolves default phase latency budgets for Stage 6.85 mission evaluation.
 *
 * @returns Computed `MissionPhaseLatencyBudgetV1` result.
 */
export function resolveDefaultLatencyBudgetsMs(): MissionPhaseLatencyBudgetV1 {
  return {
    planning: 8_000,
    vote_collection: 4_000,
    execution: 10_000,
    response_rendering: 2_000
  };
}

/**
 * Evaluates phase latencies against deterministic Stage 6.85 mission budgets.
 *
 * @param input - Structured input object for this operation.
 * @returns Ordered collection produced by this step.
 */
export function evaluatePhaseLatencies(input: {
  observedMs: MissionPhaseLatencyBudgetV1;
  budgetsMs: MissionPhaseLatencyBudgetV1;
}): { evaluations: readonly PhaseLatencyEvaluation[]; overallPass: boolean } {
  const phases: MissionLatencyPhaseV1[] = [
    "planning",
    "vote_collection",
    "execution",
    "response_rendering"
  ];
  const evaluations = phases.map((phase) => {
    const observedMs = input.observedMs[phase];
    const budgetMs = input.budgetsMs[phase];
    return {
      phase,
      observedMs,
      budgetMs,
      passed: observedMs <= budgetMs
    } satisfies PhaseLatencyEvaluation;
  });
  return {
    evaluations,
    overallPass: evaluations.every((evaluation) => evaluation.passed)
  };
}

/**
 * Evaluates whether a cached path preserved baseline-equivalent model-call semantics.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `{ passed: boolean; reason: string }` result.
 */
export function evaluateCacheBaselineEquivalence(input: {
  baselineModelCalls: number;
  cachedModelCalls: number;
}): { passed: boolean; reason: string } {
  if (!Number.isInteger(input.baselineModelCalls) || input.baselineModelCalls < 0) {
    return {
      passed: false,
      reason: "Baseline model-call count is invalid."
    };
  }
  if (!Number.isInteger(input.cachedModelCalls) || input.cachedModelCalls < 0) {
    return {
      passed: false,
      reason: "Cached model-call count is invalid."
    };
  }
  if (input.cachedModelCalls > input.baselineModelCalls) {
    return {
      passed: false,
      reason: "Caching path added model calls beyond baseline semantics."
    };
  }
  return {
    passed: true,
    reason: "Caching path preserved baseline-equivalent model call count."
  };
}

/**
 * Builds a deterministic reject summary for Stage 6.85 latency policy results.
 *
 * @param reasons - Value for reasons.
 * @returns Resulting string value.
 */
export function buildDeterministicRejectSummary(reasons: readonly string[]): string {
  const normalized = toSortedUnique(reasons.map((reason) => reason.trim()).filter((reason) => reason.length > 0));
  if (normalized.length === 0) {
    return "No reject reasons.";
  }
  return normalized.join(" | ");
}
