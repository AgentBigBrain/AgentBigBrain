/**
 * @fileoverview Deterministic bridge between repeated workflow patterns and governed skill reuse suggestions.
 */

import { rankSkillOpportunityPatterns } from "../../core/workflowLearningRuntime/skillOpportunityRanking";
import type { WorkflowPattern } from "../../core/types";
import type { SkillInventoryEntry } from "./contracts";
import {
  deriveSuggestedSkillName,
  describeSkillSuggestion,
  shouldSuggestSkillFromWorkflow
} from "./skillSuggestionPolicy";

export interface WorkflowSkillSuggestion {
  workflowKey: string;
  suggestedSkillName: string;
  reason: string;
  confidence: number;
}

export interface WorkflowSkillBridgeSummary {
  preferredSkill: SkillInventoryEntry | null;
  preferredWorkflowKey: string | null;
  preferredReason: string | null;
  discouragedWorkflowKeys: readonly string[];
  skillSuggestions: readonly WorkflowSkillSuggestion[];
}

interface BuildWorkflowSkillBridgeInput {
  workflowHints: readonly WorkflowPattern[];
  availableSkills: readonly SkillInventoryEntry[];
}

/**
 * Scores a workflow pattern for reusable-skill preference decisions.
 *
 * @param pattern - Candidate workflow pattern.
 * @returns Numeric preference score.
 */
function scoreReusableSkillPattern(pattern: WorkflowPattern): number {
  const failurePenalty = pattern.failureCount * 0.55 + pattern.suppressedCount * 0.35;
  const verificationBonus = pattern.linkedSkillVerificationStatus === "verified" ? 1.1 : 0;
  return Number(
    (pattern.confidence + pattern.successCount * 0.25 - failurePenalty + verificationBonus).toFixed(4)
  );
}

/**
 * Resolves the best verified skill already linked to the current workflow hints.
 *
 * @param workflowHints - Relevant workflow patterns returned to the planner.
 * @param availableSkills - Canonical skill inventory.
 * @returns Preferred-skill summary fields for the bridge.
 */
function resolvePreferredSkill(
  workflowHints: readonly WorkflowPattern[],
  availableSkills: readonly SkillInventoryEntry[]
): {
  preferredSkill: SkillInventoryEntry | null;
  preferredWorkflowKey: string | null;
  preferredReason: string | null;
} {
  const verifiedSkillMap = new Map(
    availableSkills
      .filter((skill) => skill.lifecycleStatus === "active" && skill.verificationStatus === "verified")
      .map((skill) => [skill.name, skill] as const)
  );
  const rankedPreferredPatterns = workflowHints
    .filter(
      (pattern) =>
        pattern.status === "active" &&
        pattern.linkedSkillName &&
        pattern.linkedSkillVerificationStatus === "verified" &&
        verifiedSkillMap.has(pattern.linkedSkillName)
    )
    .sort((left, right) => scoreReusableSkillPattern(right) - scoreReusableSkillPattern(left));

  const preferredPattern = rankedPreferredPatterns[0];
  if (!preferredPattern || !preferredPattern.linkedSkillName) {
    return {
      preferredSkill: null,
      preferredWorkflowKey: null,
      preferredReason: null
    };
  }

  return {
    preferredSkill: verifiedSkillMap.get(preferredPattern.linkedSkillName) ?? null,
    preferredWorkflowKey: preferredPattern.workflowKey,
    preferredReason:
      `A verified skill matched a repeated active workflow with ` +
      `${preferredPattern.successCount} successful uses.`
  };
}

/**
 * Collects workflow keys that should be treated cautiously because failures dominate successes.
 *
 * @param workflowHints - Relevant workflow patterns returned to the planner.
 * @returns Discouraged workflow keys.
 */
function resolveDiscouragedWorkflowKeys(workflowHints: readonly WorkflowPattern[]): readonly string[] {
  return workflowHints
    .filter(
      (pattern) =>
        pattern.status === "active" &&
        pattern.failureCount + pattern.suppressedCount > pattern.successCount &&
        pattern.failureCount + pattern.suppressedCount > 0
    )
    .map((pattern) => pattern.workflowKey)
    .slice(0, 3);
}

/**
 * Converts repeated reusable workflow opportunities into governed skill suggestions.
 *
 * @param workflowHints - Relevant workflow patterns returned to the planner.
 * @returns Ranked skill suggestions for the bridge summary.
 */
function resolveSkillSuggestions(
  workflowHints: readonly WorkflowPattern[]
): readonly WorkflowSkillSuggestion[] {
  return rankSkillOpportunityPatterns(workflowHints)
    .filter((pattern) => shouldSuggestSkillFromWorkflow(pattern))
    .slice(0, 3)
    .map((pattern) => ({
      workflowKey: pattern.workflowKey,
      suggestedSkillName: deriveSuggestedSkillName(pattern),
      reason: describeSkillSuggestion(pattern),
      confidence: pattern.confidence
    }));
}

/**
 * Builds a deterministic summary linking relevant workflow hints to skill reuse or skill-creation opportunities.
 *
 * @param input - Workflow hints and available skill inventory for the current planning pass.
 * @returns Summary used by orchestrator/planner learning guidance.
 */
export function buildWorkflowSkillBridgeSummary(
  input: BuildWorkflowSkillBridgeInput
): WorkflowSkillBridgeSummary | null {
  if (input.workflowHints.length === 0) {
    return null;
  }
  const preferred = resolvePreferredSkill(input.workflowHints, input.availableSkills);
  const discouragedWorkflowKeys = resolveDiscouragedWorkflowKeys(input.workflowHints);
  const skillSuggestions = resolveSkillSuggestions(input.workflowHints);
  if (!preferred.preferredSkill && discouragedWorkflowKeys.length === 0 && skillSuggestions.length === 0) {
    return null;
  }
  return {
    preferredSkill: preferred.preferredSkill,
    preferredWorkflowKey: preferred.preferredWorkflowKey,
    preferredReason: preferred.preferredReason,
    discouragedWorkflowKeys,
    skillSuggestions
  };
}
