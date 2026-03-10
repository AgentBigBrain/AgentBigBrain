/**
 * @fileoverview Resolves one bounded clarification question for ambiguous build or execute intent.
 */

import type { RoutingMapClassificationV1 } from "../routingMap";

export interface ExecutionIntentClarificationResolution {
  question: string | null;
  mode: "plan_or_build" | "explain_or_execute" | null;
  matchedRuleId: string | null;
}

const PLAN_ONLY_PATTERNS: readonly RegExp[] = [
  /\b(plan it|plan first|walk me through|outline it|proposal first|just plan)\b/i,
  /\b(explain first|talk me through|guide me first)\b/i,
  /\b(do not execute|don't execute|without executing|guidance only|instructions only)\b/i,
  /\b(do not build|don't build)\b/i
] as const;

const DIRECT_EXECUTION_PATTERNS: readonly RegExp[] = [
  /\b(execute now|build (?:this )?now|do it now|fix (?:it|this) now|repair (?:it|this) now|run it now|ship it now)\b/i,
  /\b(go ahead and|just)\s+(?:build|create|fix|implement|run|execute|ship|do)\b/i,
  /\bplease\s+(?:build|create|fix|implement|run|execute)\s+(?:it|this)\s+now\b/i
] as const;

const AMBIGUOUS_BUILD_PATTERNS: readonly RegExp[] = [
  /\b(create|build|make|generate|implement|add|scaffold|set up|setup|spin up)\b/i,
  /\b(app|application|project|feature|dashboard|site|website|frontend|backend|api|cli|repo|repository|page)\b/i
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

  if (matchesAny(normalized, PLAN_ONLY_PATTERNS) || matchesAny(normalized, DIRECT_EXECUTION_PATTERNS)) {
    return {
      question: null,
      mode: null,
      matchedRuleId: null
    };
  }

  if (routingClassification?.category === "BUILD_SCAFFOLD" || matchesAll(normalized, AMBIGUOUS_BUILD_PATTERNS)) {
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
