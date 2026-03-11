/**
 * @fileoverview Deterministic ranking helpers for workflow motifs that may justify reusable skills.
 */

import type { WorkflowPattern } from "../types";

/**
 * Computes a deterministic skill-opportunity score for one workflow pattern.
 *
 * @param pattern - Workflow pattern candidate.
 * @returns Score used to rank reusable-skill opportunities.
 */
export function computeSkillOpportunityScore(pattern: WorkflowPattern): number {
  if (pattern.status !== "active") {
    return -1;
  }
  const repeatedSuccessScore = pattern.successCount * 0.4;
  const failurePenalty = pattern.failureCount * 0.5 + pattern.suppressedCount * 0.35;
  const skillPenalty = pattern.linkedSkillName ? 1.5 : 0;
  const executionStyleBonus = pattern.executionStyle === "skill_based" ? -0.75 : 0.5;
  return Number(
    (pattern.confidence + repeatedSuccessScore - failurePenalty - skillPenalty + executionStyleBonus)
      .toFixed(4)
  );
}

/**
 * Ranks workflow patterns that may justify reusable skill creation.
 *
 * @param patterns - Workflow patterns to inspect.
 * @returns Ranked candidate workflow patterns.
 */
export function rankSkillOpportunityPatterns(
  patterns: readonly WorkflowPattern[]
): readonly WorkflowPattern[] {
  return [...patterns]
    .filter((pattern) => pattern.status === "active")
    .sort((left, right) => {
      const leftScore = computeSkillOpportunityScore(left);
      const rightScore = computeSkillOpportunityScore(right);
      if (leftScore !== rightScore) {
        return rightScore - leftScore;
      }
      return right.lastSeenAt.localeCompare(left.lastSeenAt);
    });
}
