/**
 * @fileoverview Deterministic workflow-pattern query ranking helpers.
 */

import type { WorkflowPattern } from "../types";
import type { RankedWorkflowPattern } from "./contracts";

/**
 * Normalizes one workflow query token for deterministic matching.
 *
 * @param value - Candidate query token.
 * @returns Normalized query token.
 */
export function normalizeWorkflowQueryToken(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Derives query tokens from natural-language planner input.
 *
 * @param query - Planner query text.
 * @returns Deduplicated bounded query token list.
 */
export function deriveWorkflowQueryTokens(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .map((entry) => normalizeWorkflowQueryToken(entry))
        .filter((entry) => entry.length >= 3)
    )
  ].slice(0, 12);
}

/**
 * Computes a bounded session-domain adjustment for one workflow pattern.
 *
 * @param pattern - Candidate workflow pattern.
 * @param sessionDomainLane - Current session lane, if known.
 * @returns Deterministic ranking adjustment.
 */
function computeWorkflowDomainScore(
  pattern: Pick<WorkflowPattern, "domainLane">,
  sessionDomainLane: string | null | undefined
): number {
  if (!sessionDomainLane || sessionDomainLane === "unknown") {
    return 0;
  }
  const normalizedPatternLane = pattern.domainLane.trim().toLowerCase();
  if (!normalizedPatternLane || normalizedPatternLane === "unknown") {
    return 0.1;
  }
  if (normalizedPatternLane === sessionDomainLane) {
    return 0.9;
  }
  return -0.35;
}

/**
 * Computes a deterministic relevance score for one workflow pattern.
 *
 * @param pattern - Workflow pattern candidate.
 * @param queryTokens - Normalized query tokens.
 * @returns Ranking score used to sort relevant workflow patterns.
 */
export function computeWorkflowPatternScore(
  pattern: WorkflowPattern,
  queryTokens: readonly string[],
  sessionDomainLane?: string | null
): number {
  const haystacks = [
    pattern.workflowKey.toLowerCase(),
    ...pattern.contextTags.map((tag) => tag.toLowerCase()),
    pattern.actionSequenceShape?.toLowerCase() ?? "",
    pattern.linkedSkillName?.toLowerCase() ?? "",
    pattern.dominantFailureMode?.toLowerCase() ?? ""
  ];
  const overlapScore = queryTokens.reduce((score, token) => {
    if (haystacks.some((entry) => entry.includes(token))) {
      return score + 1;
    }
    return score;
  }, 0);

  const reliabilityScore = pattern.successCount - pattern.failureCount - pattern.suppressedCount * 0.5;
  const verificationBonus = pattern.linkedSkillVerificationStatus === "verified" ? 1.25 : 0;
  const activeBonus = pattern.status === "active" ? 1 : -1;
  const domainScore = computeWorkflowDomainScore(pattern, sessionDomainLane);
  return Number(
    (
      overlapScore * 1.4 +
      pattern.confidence +
      reliabilityScore * 0.15 +
      verificationBonus +
      activeBonus +
      domainScore
    )
      .toFixed(4)
  );
}

/**
 * Ranks active workflow patterns for a query using structured deterministic signals.
 *
 * @param patterns - All known workflow patterns.
 * @param query - Planner query text.
 * @param limit - Maximum number of patterns to return.
 * @returns Ranked active workflow patterns.
 */
export function rankRelevantWorkflowPatterns(
  patterns: readonly WorkflowPattern[],
  query: string,
  limit: number,
  sessionDomainLane?: string | null
): readonly WorkflowPattern[] {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  const queryTokens = deriveWorkflowQueryTokens(query);
  const ranked: RankedWorkflowPattern[] = patterns
    .filter((pattern) => pattern.status === "active")
    .map((pattern) => ({
      pattern,
      score: computeWorkflowPatternScore(pattern, queryTokens, sessionDomainLane)
    }))
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      if (left.pattern.confidence !== right.pattern.confidence) {
        return right.pattern.confidence - left.pattern.confidence;
      }
      if (left.pattern.lastSeenAt !== right.pattern.lastSeenAt) {
        return right.pattern.lastSeenAt.localeCompare(left.pattern.lastSeenAt);
      }
      return left.pattern.id.localeCompare(right.pattern.id);
    });
  return ranked.slice(0, normalizedLimit).map((entry) => entry.pattern);
}
