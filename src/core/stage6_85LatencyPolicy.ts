/**
 * @fileoverview Thin compatibility entrypoint for canonical Stage 6.85 latency-policy helpers.
 */

export type {
  MissionLatencyPhaseV1,
  MissionPhaseLatencyBudgetV1,
  PhaseLatencyEvaluation
} from "./stage6_85/latency";
export {
  buildDeterministicRejectSummary,
  evaluateCacheBaselineEquivalence,
  evaluatePhaseLatencies,
  resolveDefaultLatencyBudgetsMs
} from "./stage6_85/latency";
