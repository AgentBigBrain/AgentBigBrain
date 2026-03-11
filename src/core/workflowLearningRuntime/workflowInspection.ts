/**
 * @fileoverview Operator-facing rendering helpers for workflow-learning inspection.
 */

import type { WorkflowPattern } from "../types";
import type { WorkflowInspectionEntry } from "./contracts";

/**
 * Converts workflow patterns into operator-facing inspection entries.
 *
 * @param patterns - Workflow patterns to summarize.
 * @returns Sorted operator-facing workflow inspection entries.
 */
export function summarizeWorkflowPatterns(
  patterns: readonly WorkflowPattern[]
): readonly WorkflowInspectionEntry[] {
  return [...patterns]
    .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
    .map((pattern) => ({
      workflowKey: pattern.workflowKey,
      confidence: pattern.confidence,
      status: pattern.status,
      outcomeCounts: {
        success: pattern.successCount,
        failure: pattern.failureCount,
        suppressed: pattern.suppressedCount
      },
      executionStyle: pattern.executionStyle ?? null,
      linkedSkillName: pattern.linkedSkillName ?? null,
      linkedSkillVerificationStatus: pattern.linkedSkillVerificationStatus ?? null,
      updatedAt: pattern.lastSeenAt
    }));
}
