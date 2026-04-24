/**
 * @fileoverview Resolves bounded natural-language continuity promotions for the conversation front door.
 */

import { extractExecutionPreferences } from "./executionPreferenceExtraction";
import { isDirectConversationOnlyRequest } from "./directConversationIntent";
import {
  buildRecentIdentityInterpretationContext,
  shouldPreserveDeterministicDirectChatTurn
} from "./chatTurnSignals";
import {
  buildRecentAssistantTurnContext,
  isRecentAssistantAnswerThreadContinuationCandidate
} from "./recentAssistantTurnContext";
import type { ResolvedConversationIntentMode } from "./intentModeContracts";
import type { ConversationIntentMode, ConversationSession } from "../sessionStore";

const CONTINUE_WORK_PATTERNS: readonly RegExp[] = [
  /^(?:okay|ok|yeah|yes|sure|please|alright|all right)[,!\s-]*(?:go ahead|keep going|continue|carry on|take it from here|finish it|do that|do it)\b/i,
  /^(?:go ahead|keep going|continue|carry on|take it from here|finish it|do that|do it)\b/i,
  /\bkeep going with (?:it|that|this)\b/i,
  /\bfinish (?:it|that|this)\b/i
] as const;

const DESTINATION_REFERENCE_PATTERNS: readonly RegExp[] = [
  /\bsame place as before\b/i,
  /\bsame place as last time\b/i,
  /\bsame folder\b/i,
  /\bsame destination\b/i,
  /\bleave it where you put (?:it|that|this|the last one)\b/i,
  /\bput it on my desktop\b/i,
  /\bfolder called\b/i
] as const;

const WORK_PRODUCT_CONTINUATION_PATTERNS: readonly RegExp[] = [
  /\b(?:turn|transform|convert|expand)\b[\s\S]{0,40}\b(?:that|this|the)\b[\s\S]{0,20}\b(?:plan|outline|draft|copy)\b/i,
  /\b(?:write|draft|outline|refine|revise|edit|update|change|add|remove)\b[\s\S]{0,80}\b(?:hero|headline|supporting paragraph|call[- ]to[- ]action|cta|section|outline|copy|draft|trust bar|image)\b/i,
  /\b(?:next|now|then|after that)\b[\s,:-]*(?:please\s+)?(?:write|draft|outline|refine|revise|edit|update|change|add|remove|turn|transform|convert|expand)\b/i
] as const;

const CONTINUABLE_MODES = new Set<ConversationIntentMode>([
  "plan",
  "build",
  "static_html_build",
  "framework_app_build",
  "autonomous",
  "review"
]);
const CONTINUATION_INTERPRETATION_MAX_CHARS = 160;

/**
 * Builds a promoted intent result when the current utterance clearly means "keep doing the same kind of work."
 *
 * @param session - Current conversation session with mode continuity metadata.
 * @param matchedRuleId - Rule identifier explaining why continuity promotion matched.
 * @param explanation - Human-readable reason for the promotion.
 * @param confidence - Confidence assigned to the promoted routing decision.
 * @returns Resolved intent mode that preserves the active working mode.
 */
function buildContinuityResolution(
  session: ConversationSession,
  matchedRuleId: string,
  explanation: string,
  confidence: ResolvedConversationIntentMode["confidence"] = "medium"
): ResolvedConversationIntentMode {
  return {
    mode: session.modeContinuity?.activeMode ?? "chat",
    confidence,
    matchedRuleId,
    explanation,
    clarification: null
  };
}

/**
 * Returns whether a bounded model-assisted continuation check is allowed for this turn after the
 * deterministic continuity fast path has already failed.
 *
 * @param session - Current conversation session containing the last affirmed working mode.
 * @param userInput - Raw current user text.
 * @param resolvedIntentMode - Canonical intent result before model-assisted continuity promotion.
 * @returns `true` when a bounded continuation-interpretation call is allowed.
 */
export function shouldAttemptModeContinuityInterpretation(
  session: ConversationSession,
  userInput: string,
  resolvedIntentMode: ResolvedConversationIntentMode
): boolean {
  const continuity = session.modeContinuity;
  if (!continuity) {
    return false;
  }
  if (resolvedIntentMode.mode !== "chat" && resolvedIntentMode.mode !== "unclear") {
    return false;
  }
  if (resolvedIntentMode.clarification) {
    return false;
  }
  if (!CONTINUABLE_MODES.has(continuity.activeMode)) {
    return false;
  }
  const normalized = userInput.trim();
  if (!normalized || normalized.includes("\n") || normalized.length > CONTINUATION_INTERPRETATION_MAX_CHARS) {
    return false;
  }
  const recentIdentityContext = buildRecentIdentityInterpretationContext(
    session.conversationTurns.slice(-4)
  );
  if (
    isDirectConversationOnlyRequest(normalized) ||
    shouldPreserveDeterministicDirectChatTurn(normalized, recentIdentityContext)
  ) {
    return false;
  }
  if (
    isRecentAssistantAnswerThreadContinuationCandidate(
      normalized,
      buildRecentAssistantTurnContext(session)
    )
  ) {
    return false;
  }
  return resolveModeContinuityIntent(session, userInput, resolvedIntentMode) === null;
}

/**
 * Builds a promoted continuity intent from a validated continuation-interpretation result.
 *
 * @param session - Current conversation session with the active continuity mode.
 * @param explanation - Bounded explanation returned by continuation interpretation.
 * @param confidence - Confidence returned by continuation interpretation.
 * @returns Promoted continuity intent preserving the active working mode.
 */
export function buildModeContinuityInterpretationResolution(
  session: ConversationSession,
  explanation: string,
  confidence: "high" | "medium" | "low"
): ResolvedConversationIntentMode {
  return buildContinuityResolution(
    session,
    "intent_mode_continuity_local_interpretation",
    explanation,
    confidence === "high" ? "high" : "medium"
  );
}

/**
 * Promotes vague follow-up language into the current working mode only when the session already
 * has a strong continuity anchor and the new utterance clearly sounds like "keep doing that."
 *
 * @param session - Current conversation session containing the last affirmed working mode.
 * @param userInput - Raw current user text.
 * @param resolvedIntentMode - Canonical intent result before continuity promotion.
 * @returns A promoted intent result when continuity is strong enough, otherwise `null`.
 */
export function resolveModeContinuityIntent(
  session: ConversationSession,
  userInput: string,
  resolvedIntentMode: ResolvedConversationIntentMode
): ResolvedConversationIntentMode | null {
  const continuity = session.modeContinuity;
  if (!continuity) {
    return null;
  }

  if (resolvedIntentMode.mode !== "chat" && resolvedIntentMode.mode !== "unclear") {
    return null;
  }
  if (resolvedIntentMode.clarification) {
    return null;
  }
  if (!CONTINUABLE_MODES.has(continuity.activeMode)) {
    return null;
  }

  const normalized = userInput.trim();
  if (!normalized) {
    return null;
  }
  if (isDirectConversationOnlyRequest(normalized)) {
    return null;
  }
  if (
    isRecentAssistantAnswerThreadContinuationCandidate(
      normalized,
      buildRecentAssistantTurnContext(session)
    )
  ) {
    return null;
  }

  const preferences = extractExecutionPreferences(normalized);
  const hasContinuationCue = CONTINUE_WORK_PATTERNS.some((pattern) => pattern.test(normalized));
  const hasDestinationCue = DESTINATION_REFERENCE_PATTERNS.some((pattern) => pattern.test(normalized));
  const hasReuseCue = preferences.reusePriorApproach;
  const hasPresentationCue =
    preferences.presentation.keepVisible ||
    preferences.presentation.leaveOpen ||
    preferences.presentation.runLocally;
  const hasWorkProductContinuationCue = WORK_PRODUCT_CONTINUATION_PATTERNS.some((pattern) =>
    pattern.test(normalized)
  );

  if (hasContinuationCue) {
    return buildContinuityResolution(
      session,
      "intent_mode_continuity_continue_work",
      "The user used a strong continuation phrase that should stay in the current working mode.",
      "high"
    );
  }

  if (
    continuity.activeMode === "build" ||
    continuity.activeMode === "static_html_build" ||
    continuity.activeMode === "framework_app_build" ||
    continuity.activeMode === "autonomous" ||
    continuity.activeMode === "review" ||
    continuity.activeMode === "plan"
  ) {
    if (hasWorkProductContinuationCue) {
      return buildContinuityResolution(
        session,
        "intent_mode_continuity_work_product_follow_up",
        "The user asked for the next transformation or drafting step on the current work product, so the active working mode should continue.",
        "high"
      );
    }
    if (hasDestinationCue) {
      return buildContinuityResolution(
        session,
        "intent_mode_continuity_destination",
        "The user referenced the same destination or a remembered desktop/folder target, which should continue the current working mode."
      );
    }
    if (hasReuseCue) {
      return buildContinuityResolution(
        session,
        "intent_mode_continuity_reuse",
        "The user asked to reuse the same approach or tool, which should continue the active working mode."
      );
    }
    if (hasPresentationCue) {
      return buildContinuityResolution(
        session,
        "intent_mode_continuity_presentation",
        "The user gave a presentation preference like leaving the result open or visible, which should continue the current build/run flow."
      );
    }
  }

  if (continuity.activeMode === "plan" && hasReuseCue) {
    return buildContinuityResolution(
      session,
      "intent_mode_continuity_plan_reuse",
      "The user asked to keep using the same earlier approach while the conversation is still in plan mode."
    );
  }

  return null;
}
