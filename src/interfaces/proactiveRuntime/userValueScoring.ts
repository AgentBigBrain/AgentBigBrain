/**
 * @fileoverview Deterministic user-value scoring for bounded proactive follow-up.
 */

import type { RelationshipClarificationUtilityRequest } from "./contracts";

/**
 * Scores whether a relationship-clarification pulse is worth interrupting for.
 *
 * @param request - Bounded continuity and response-history signals.
 * @returns Utility score in the unit interval.
 */
export function calculateRelationshipClarificationUtilityScore(
  request: RelationshipClarificationUtilityRequest
): number {
  let score = 0;

  score += Math.min(0.5, request.anchoredEntityCount * 0.25);
  score += Math.min(0.35, request.openLoopCount * 0.25);
  score -= Math.min(0.45, request.repeatedNegativeOutcomes * 0.2);

  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}
