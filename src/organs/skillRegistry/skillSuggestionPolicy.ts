/**
 * @fileoverview Deterministic guardrails for when repeated workflow patterns justify reusable skill suggestions.
 */

import type { WorkflowPattern } from "../../core/types";

/**
 * Builds a stable suggested skill name from a workflow pattern when no linked skill exists yet.
 *
 * @param pattern - Repeated workflow candidate.
 * @returns Suggested skill name.
 */
export function deriveSuggestedSkillName(pattern: WorkflowPattern): string {
  const [, workflowSuffix = "workflow"] = pattern.workflowKey.split(":");
  const normalizedSuffix = workflowSuffix
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((entry) => entry.length > 0)
    .slice(0, 4)
    .join("_");
  return `workflow_${normalizedSuffix || "helper"}`;
}

/**
 * Evaluates whether a workflow pattern is mature enough to justify a reusable skill suggestion.
 *
 * @param pattern - Workflow pattern candidate.
 * @returns `true` when the workflow is stable enough to suggest a reusable skill.
 */
export function shouldSuggestSkillFromWorkflow(pattern: WorkflowPattern): boolean {
  if (pattern.status !== "active" || pattern.linkedSkillName) {
    return false;
  }
  if (pattern.confidence < 0.55 || pattern.successCount < 2) {
    return false;
  }
  return pattern.successCount > pattern.failureCount + pattern.suppressedCount;
}

/**
 * Renders a human-readable explanation for why a workflow became a skill suggestion.
 *
 * @param pattern - Workflow pattern driving the suggestion.
 * @returns Short suggestion explanation suitable for planner/operator output.
 */
export function describeSkillSuggestion(pattern: WorkflowPattern): string {
  return (
    `Repeated active workflow (${pattern.workflowKey}) succeeded ${pattern.successCount} times ` +
    `with confidence ${pattern.confidence.toFixed(2)}.`
  );
}
