/**
 * @fileoverview Shared helper builders for intent-mode resolution.
 */

import type { ResolvedConversationIntentMode } from "./intentModeContracts";
import {
  hasAmbiguousBuildFormatRequestShape,
  hasExplicitBuildFormatAmbiguityCue,
  hasFormatSensitiveBuildDestinationShape
} from "./intentModeBuildFormatSupport";

interface BuildFormatClarificationEligibility {
  normalized: string;
  planOnly: boolean;
  statusOrRecall: boolean;
  explicitStaticHtmlBuildRequested: boolean;
  explicitFrameworkBuildRequested: boolean;
}

/**
 * Returns the canonical low-confidence chat fallback used when no stronger front-door intent
 * survives bounded routing.
 */
export function buildDefaultChatIntentMode(): ResolvedConversationIntentMode {
  return {
    mode: "chat",
    confidence: "low",
    matchedRuleId: "intent_mode_default_chat",
    explanation: "No stronger execution or capability intent was detected.",
    clarification: null,
    semanticRouteId: "chat_answer"
  };
}

/**
 * Returns whether the turn should trigger build-format clarification instead of guessing HTML
 * versus framework output.
 */
export function shouldClarifyBuildFormatRequest(
  options: BuildFormatClarificationEligibility
): boolean {
  return (
    !options.planOnly &&
    !options.statusOrRecall &&
    !options.explicitStaticHtmlBuildRequested &&
    !options.explicitFrameworkBuildRequested &&
    hasAmbiguousBuildFormatRequestShape(options.normalized) &&
    (
      hasFormatSensitiveBuildDestinationShape(options.normalized) ||
      hasExplicitBuildFormatAmbiguityCue(options.normalized)
    )
  );
}
