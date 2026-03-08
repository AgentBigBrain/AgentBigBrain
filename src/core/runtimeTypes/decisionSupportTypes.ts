/**
 * @fileoverview Canonical delegation, first-principles, and failure-taxonomy contracts extracted from the shared runtime type surface.
 */

import type { GovernanceBlockCategory } from "./governanceOutcomeTypes";

export interface SubagentDelegationSignal {
  capabilityGapScore: number;
  parallelGainScore: number;
  riskReductionScore: number;
  budgetPressureScore: number;
  currentSubagentCount: number;
  requestedDepth: number;
  requiresEscalationApproval: boolean;
}

export interface SubagentDelegationLimits {
  maxSubagentsPerTask: number;
  maxSubagentDepth: number;
  spawnThresholdScore: number;
}

export interface SubagentDelegationDecision {
  shouldSpawn: boolean;
  spawnScore: number;
  blockedBy: readonly string[];
  reasons: readonly string[];
}

export interface FirstPrinciplesRubric {
  facts: readonly string[];
  assumptions: readonly string[];
  constraints: readonly string[];
  unknowns: readonly string[];
  minimalPlan: string;
}

export interface FirstPrinciplesValidationResult {
  valid: boolean;
  violationCodes: readonly string[];
}

export interface FirstPrinciplesPacketV1 {
  required: boolean;
  triggerReasons: readonly string[];
  rubric: FirstPrinciplesRubric | null;
  validation: FirstPrinciplesValidationResult | null;
}

export type FailureTaxonomyCategory =
  | "constraint"
  | "objective"
  | "reasoning"
  | "quality"
  | "human_feedback";

export type FailureTaxonomyCodeV1 =
  | "constraint_blocked"
  | "objective_not_met"
  | "reasoning_planner_failed"
  | "quality_rejected"
  | "human_feedback_required";

export interface FailureTaxonomyResultV1 {
  failureCategory: FailureTaxonomyCategory;
  failureCode: FailureTaxonomyCodeV1;
}

export interface FailureTaxonomySignal {
  blockCategory: GovernanceBlockCategory;
  violationCodes: readonly string[];
  objectivePass: boolean;
  humanFeedbackOnly: boolean;
  summary: string;
}
