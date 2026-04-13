/**
 * @fileoverview Resolves one bounded clarification question for ambiguous build or execute intent.
 */

import type { RoutingMapClassificationV1 } from "../routingMap";
import {
  extractExecutionPreferences,
  isNaturalAutonomousExecutionRequest
} from "./executionPreferenceExtraction";

export interface ExecutionIntentClarificationResolution {
  question: string | null;
  mode: "plan_or_build" | "explain_or_execute" | null;
  matchedRuleId: string | null;
}

const AMBIGUOUS_BUILD_PATTERNS: readonly RegExp[] = [
  /\b(create|build|make|generate|implement|scaffold|set up|setup|spin up)\b/i,
  /\b(app|application|project|feature|dashboard|site|website|frontend|backend|api|cli|repo|repository|page)\b/i
] as const;

const AMBIGUOUS_BUILD_REQUEST_LEAD_PATTERNS: readonly RegExp[] = [
  /^(?:please\s+)?(?:create|build|make|generate|implement|scaffold|set up|setup|spin up)\b/i,
  /\b(?:can you|could you|would you|will you|please|i need you to|help me|let'?s)\b[\s\S]{0,48}\b(?:create|build|make|generate|implement|scaffold|set up|setup|spin up)\b/i
] as const;

const AMBIGUOUS_EXECUTION_PATTERNS: readonly RegExp[] = [
  /\b(bug|issue|problem|regression|failure|failing|broken|wrong|test|tests|screenshot|error)\b/i
] as const;

const AMBIGUOUS_EXECUTION_VERB_PATTERNS: readonly RegExp[] = [
  /\b(fix|repair|debug|resolve|clean up|correct|change|update|refactor)\b/i
] as const;

const AMBIGUOUS_EXECUTION_MEDIA_EVIDENCE_PATTERNS: readonly RegExp[] = [
  /\b(screenshot|screen shot|image|photo|clip|video|voice note|voice memo|audio)\b/i
] as const;

/**
 * Returns `true` when any clarification pattern matches the current user input.
 *
 * @param text - Current user input.
 * @param patterns - Candidate regex patterns for one intent bucket.
 * @returns Whether at least one pattern matched.
 */
function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Returns `true` when all clarification patterns match the current user input.
 *
 * @param text - Current user input.
 * @param patterns - Candidate regex patterns for one intent bucket.
 * @returns Whether every pattern matched.
 */
function matchesAll(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.every((pattern) => pattern.test(text));
}

/**
 * Returns whether ambiguous build wording is framed like an actual build request instead of a
 * narrative memory update that happens to mention words like `project`.
 *
 * @param text - Current user input.
 * @returns Whether the wording looks like a direct request to create or build something.
 */
function isLikelyBuildRequestLead(text: string): boolean {
  return matchesAny(text, AMBIGUOUS_BUILD_REQUEST_LEAD_PATTERNS);
}

/**
 * Resolves whether one ambiguous request should trigger a single clarification question.
 *
 * @param userInput - Raw current user request before execution-input wrapping.
 * @param routingClassification - Optional deterministic routing classification.
 * @returns Clarification question metadata, or `null` fields when no clarification is needed.
 */
export function resolveExecutionIntentClarification(
  userInput: string,
  routingClassification: RoutingMapClassificationV1 | null = null
): ExecutionIntentClarificationResolution {
  const normalized = userInput.trim();
  if (!normalized) {
    return {
      question: null,
      mode: null,
      matchedRuleId: null
    };
  }

  const preferences = extractExecutionPreferences(normalized);
  if (
    preferences.planOnly ||
    preferences.executeNow ||
    preferences.statusOrRecall ||
    preferences.naturalSkillDiscovery ||
    preferences.reusePriorApproach ||
    isNaturalAutonomousExecutionRequest(normalized)
  ) {
    return {
      question: null,
      mode: null,
      matchedRuleId: null
    };
  }

  if (
    routingClassification?.category === "BUILD_SCAFFOLD" ||
    (matchesAll(normalized, AMBIGUOUS_BUILD_PATTERNS) && isLikelyBuildRequestLead(normalized))
  ) {
    return {
      question: "Do you want me to plan it first or build it now?",
      mode: "plan_or_build",
      matchedRuleId: routingClassification?.category === "BUILD_SCAFFOLD"
        ? "execution_intent_build_scaffold"
        : "execution_intent_build_generic"
    };
  }

  const hasExecutionContext = matchesAny(normalized, AMBIGUOUS_EXECUTION_PATTERNS);
  const hasExecutionVerb = matchesAny(normalized, AMBIGUOUS_EXECUTION_VERB_PATTERNS);
  const hasExecutionMediaEvidence = matchesAny(
    normalized,
    AMBIGUOUS_EXECUTION_MEDIA_EVIDENCE_PATTERNS
  );

  if (hasExecutionContext && (hasExecutionVerb || hasExecutionMediaEvidence)) {
    return {
      question: "Do you want me to explain the issue first or fix it now?",
      mode: "explain_or_execute",
      matchedRuleId: "execution_intent_fix_or_explain"
    };
  }

  return {
    question: null,
    mode: null,
    matchedRuleId: null
  };
}
