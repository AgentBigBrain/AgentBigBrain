/**
 * @fileoverview Deterministic first-principles trigger and rubric helpers for planner policy.
 */

import {
  createFirstPrinciplesRubric,
  validateFirstPrinciplesRubric
} from "../../core/advancedAutonomyFoundation";
import type {
  FirstPrinciplesPacketV1,
  TaskRequest
} from "../../core/types";

const FIRST_PRINCIPLES_RISK_PATTERNS: readonly RegExp[] = [
  /\b(delete|remove|rm)\b/i,
  /\b(network|api|webhook|endpoint|http[s]?:\/\/)\b/i,
  /\b(secret|token|credential|password|private key)\b/i,
  /\b(deploy|production|rollback|database migration)\b/i,
  /\b(self[-\s]?modify|modify (?:agent|runtime|policy|governor|constraint))\b/i,
  /\b(memory_mutation|pulse_emit)\b/i,
  /\b(shell|terminal|powershell|bash|zsh|cmd(?:\.exe)?)\b/i
];
const FIRST_PRINCIPLES_NOVEL_REQUEST_MIN_WORDS = 16;

export interface FirstPrinciplesTriggerDecision {
  required: boolean;
  reasons: readonly string[];
}

/**
 * Resolves whether first-principles rubric planning is mandatory for this request.
 *
 * @param currentUserRequest - Active request segment extracted from conversation/task input.
 * @param relevantLessonCount - Number of retrieved lessons available for this request.
 * @returns Trigger decision with explicit deterministic reasons.
 */
export function resolveFirstPrinciplesTriggerDecision(
  currentUserRequest: string,
  relevantLessonCount: number
): FirstPrinciplesTriggerDecision {
  const reasons: string[] = [];
  for (const pattern of FIRST_PRINCIPLES_RISK_PATTERNS) {
    if (pattern.test(currentUserRequest)) {
      reasons.push(`risk_pattern:${pattern.source}`);
    }
  }

  const wordCount = currentUserRequest
    .trim()
    .split(/\s+/)
    .filter((entry) => entry.trim().length > 0).length;
  if (
    reasons.length === 0 &&
    relevantLessonCount === 0 &&
    wordCount >= FIRST_PRINCIPLES_NOVEL_REQUEST_MIN_WORDS
  ) {
    reasons.push("novel_request:no_relevant_lessons");
  }

  return {
    required: reasons.length > 0,
    reasons: reasons.sort((left, right) => left.localeCompare(right))
  };
}

/**
 * Builds a deterministic first-principles rubric for high-risk/novel planning requests.
 *
 * @param task - Current task metadata.
 * @param currentUserRequest - Active request segment extracted from conversation/task input.
 * @param triggerReasons - Trigger reasons that required first-principles policy.
 * @returns Validated rubric packet used to guide planner prompts and persisted plan metadata.
 */
export function buildDeterministicFirstPrinciplesPacket(
  task: TaskRequest,
  currentUserRequest: string,
  triggerReasons: readonly string[]
): FirstPrinciplesPacketV1 {
  const rubric = createFirstPrinciplesRubric({
    facts: [
      `task.goal=${task.goal}`,
      `task.currentUserRequest=${currentUserRequest}`,
      "runtime.mode=governed_execution"
    ],
    assumptions: [
      "external_system_state_may_be_stale",
      "planner_output_is_untrusted_until_constraints_and_governors_pass",
      "execution_receipts_and_traces_must_remain_auditable"
    ],
    constraints: [
      "all_actions_must_pass_hard_constraints",
      "all_side_effects_require_governor_approval",
      "budget_and_deadline_limits_are_fail_closed"
    ],
    unknowns: [
      "external_dependency_availability",
      "current_filesystem_or_service_state_before_read",
      "human_intent_details_not_explicitly_stated"
    ],
    minimalPlan:
      "Derive the minimum safe action set for the active request, keep scope bounded, " +
      "and prioritize verifiable outputs with deterministic fallbacks."
  });
  const validation = validateFirstPrinciplesRubric(rubric);
  if (!validation.valid) {
    throw new Error(
      "First-principles rubric validation failed: " + validation.violationCodes.join(", ")
    );
  }

  return {
    required: true,
    triggerReasons,
    rubric,
    validation
  };
}

/**
 * Builds first-principles prompt guidance from rubric packet metadata.
 *
 * @param packet - First-principles packet prepared for the current request.
 * @returns Prompt-ready rubric guidance text, or empty string when policy is not required.
 */
export function buildFirstPrinciplesPromptGuidance(packet: FirstPrinciplesPacketV1): string {
  if (!packet.required || !packet.rubric) {
    return "";
  }
  return (
    "\nFirst-Principles Rubric (required):\n" +
    `- triggerReasons: ${packet.triggerReasons.join(", ")}\n` +
    `- facts: ${packet.rubric.facts.join(" | ")}\n` +
    `- assumptions: ${packet.rubric.assumptions.join(" | ")}\n` +
    `- constraints: ${packet.rubric.constraints.join(" | ")}\n` +
    `- unknowns: ${packet.rubric.unknowns.join(" | ")}\n` +
    `- minimalPlan: ${packet.rubric.minimalPlan}\n` +
    "Use this rubric as the mandatory planning baseline before emitting actions."
  );
}
