/**
 * @fileoverview Deterministic workflow-learning planner bias helpers.
 */

import type { WorkflowPattern } from "../types";
import type { WorkflowPlannerBiasSummary } from "./contracts";

/**
 * Splits ranked workflow patterns into preferred and discouraged buckets for planner guidance.
 *
 * @param patterns - Ranked relevant workflow patterns.
 * @returns Planner bias summary with preferred and discouraged pattern sets.
 */
export function buildWorkflowPlannerBias(
  patterns: readonly WorkflowPattern[]
): WorkflowPlannerBiasSummary {
  const preferredPatterns = patterns.filter(
    (pattern) => pattern.status === "active" && pattern.confidence >= 0.45 && pattern.successCount >= pattern.failureCount
  );
  const discouragedPatterns = patterns.filter(
    (pattern) => pattern.failureCount > pattern.successCount || pattern.suppressedCount > pattern.successCount
  );
  return {
    preferredPatterns: preferredPatterns.slice(0, 2),
    discouragedPatterns: discouragedPatterns.slice(0, 2)
  };
}

/**
 * Builds compact planner prompt guidance from a workflow bias summary.
 *
 * @param bias - Planner bias summary derived from relevant patterns.
 * @returns Prompt-ready workflow bias guidance block.
 */
export function renderWorkflowPlannerBiasGuidance(
  bias: WorkflowPlannerBiasSummary
): string {
  const lines: string[] = [];
  if (bias.preferredPatterns.length > 0) {
    lines.push(
      "Preferred workflow motifs:",
      ...bias.preferredPatterns.map((pattern) => {
        const linkedSkill =
          pattern.linkedSkillName && pattern.linkedSkillVerificationStatus === "verified"
            ? `; prefer verified skill ${pattern.linkedSkillName}`
            : "";
        return `- ${pattern.workflowKey}; confidence=${pattern.confidence.toFixed(2)}${linkedSkill}`;
      })
    );
  }
  if (bias.discouragedPatterns.length > 0) {
    lines.push(
      "Avoid degraded workflow motifs:",
      ...bias.discouragedPatterns.map((pattern) =>
        `- ${pattern.workflowKey}; failure=${pattern.failureCount}; suppressed=${pattern.suppressedCount}`
      )
    );
  }
  return lines.length > 0 ? `\n${lines.join("\n")}` : "";
}
