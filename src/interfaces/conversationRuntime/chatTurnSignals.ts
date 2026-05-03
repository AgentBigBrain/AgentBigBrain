/**
 * @fileoverview Stable conversation-runtime facade for short-turn signals, identity eligibility, and safe chat fallbacks.
 */

import type { ConversationIntentSemanticHint } from "./intentModeContracts";
import {
  analyzeConversationChatTurnSignals,
  canConversationChatTurnPrimaryKindSteerRouting,
  type ConversationChatTurnSignals,
  type ConversationTurnActionability,
  type ConversationTurnKind,
  type ConversationTurnPrimaryKindAuthority
} from "./chatTurnSignalAnalysis";
import {
  isMixedConversationMemoryStatusRecallTurn,
  isRelationshipConversationRecallTurn
} from "./chatTurnRelationshipRecall";
import {
  assessIdentityInterpretationEligibility,
  buildRecentIdentityInterpretationContext,
  type IdentityInterpretationEligibility,
  type IdentityContextRecentTurn,
  type IdentityInterpretationEligibilityContext,
  type IdentityInterpretationEligibilityReason,
  isLikelyAssistantIdentityAnswer,
  isLikelyAssistantIdentityPrompt,
  shouldPreserveDeterministicDirectChatTurn
} from "./chatTurnIdentityEligibility";

export {
  analyzeConversationChatTurnSignals,
  canConversationChatTurnPrimaryKindSteerRouting,
  assessIdentityInterpretationEligibility,
  buildRecentIdentityInterpretationContext,
  isMixedConversationMemoryStatusRecallTurn,
  isRelationshipConversationRecallTurn,
  isLikelyAssistantIdentityAnswer,
  isLikelyAssistantIdentityPrompt,
  shouldPreserveDeterministicDirectChatTurn
};
export type {
  ConversationChatTurnSignals,
  ConversationTurnActionability,
  ConversationTurnPrimaryKindAuthority,
  ConversationTurnKind,
  IdentityContextRecentTurn,
  IdentityInterpretationEligibility,
  IdentityInterpretationEligibilityContext,
  IdentityInterpretationEligibilityReason
};

/**
 * Stable re-export surface for identity-eligible short-turn analysis.
 *
 * **Why it exists:**
 * Call sites across conversation routing, direct chat, and tests should keep one stable import path
 * even as the underlying identity-eligibility and token-analysis ownership moves into thinner
 * helper modules.
 *
 * **What it talks to:**
 * - Uses `analyzeConversationChatTurnSignals` from `./chatTurnSignalAnalysis`.
 * - Uses `assessIdentityInterpretationEligibility`, `isLikelyAssistantIdentityPrompt`, and `shouldPreserveDeterministicDirectChatTurn` from `./chatTurnIdentityEligibility`.
 *
 * @returns No runtime value. This facade preserves the stable identity-eligibility export surface.
 */
export const CHAT_TURN_SIGNALS_IDENTITY_ELIGIBILITY_FACADE = true;

/**
 * Returns whether a generic status renderer should be allowed to fall back to durable handoff
 * output when no stronger recall slice matched.
 *
 * **Why it exists:**
 * Status fallbacks should stay available for explicit review/status language, but identity and
 * lightweight chat turns must not accidentally surface stale handoff summaries.
 *
 * **What it talks to:**
 * - Uses `analyzeConversationChatTurnSignals` from `./chatTurnSignalAnalysis`.
 *
 * @param userInput - Raw user wording routed into status or recall handling.
 * @param semanticHint - Optional trusted semantic hint from intent understanding.
 * @returns `true` when fallback handoff output is appropriate.
 */
export function shouldAllowImplicitReturnHandoffStatusFallback(
  userInput: string,
  semanticHint: ConversationIntentSemanticHint | null = null
): boolean {
  if (isRelationshipConversationRecallTurn(userInput)) {
    return false;
  }
  const signals = analyzeConversationChatTurnSignals(userInput);
  if (
    signals.primaryKind === "self_identity_query" ||
    signals.primaryKind === "assistant_identity_query"
  ) {
    return false;
  }
  if (semanticHint !== null) {
    return !signals.lightweightConversation;
  }
  if (signals.primaryKind === "plain_chat") {
    return false;
  }
  const normalized = userInput.replace(/\s+/g, " ").trim().toLowerCase();
  return /\b(?:status|doing|happening|working|stuck|waiting|next)\b/.test(normalized);
}

/**
 * Builds a bounded inline reply when direct conversation synthesis is unavailable but the turn is
 * still chat and must not spill onto the worker path.
 *
 * **Why it exists:**
 * Deterministic fallback replies protect the no-worker chat path when direct conversation
 * synthesis is missing or intentionally unavailable in the current environment.
 *
 * **What it talks to:**
 * - Uses `analyzeConversationChatTurnSignals` from `./chatTurnSignalAnalysis`.
 * - Uses `assessIdentityInterpretationEligibility` from `./chatTurnIdentityEligibility`.
 *
 * @param userInput - Raw current user wording.
 * @returns Deterministic no-worker fallback reply.
 */
export function buildDeterministicDirectChatFallbackReply(userInput: string): string {
  const signals = analyzeConversationChatTurnSignals(userInput);
  const identityEligibility = assessIdentityInterpretationEligibility(userInput);
  if (signals.primaryKind === "self_identity_query") {
    return "I don't want to guess your name from stale work context. Tell me what you'd like me to call you.";
  }
  if (signals.primaryKind === "self_identity_statement") {
    return "Okay, I'll use that.";
  }
  if (signals.primaryKind === "assistant_identity_query") {
    return "I'm AgentBigBrain.";
  }
  if (identityEligibility.reason === "plausible_self_identity_declaration") {
    return "I think you're telling me your name. Tell me in a short direct form if you'd like me to remember it.";
  }
  if (identityEligibility.reason === "identity_follow_up") {
    return "I want to keep this on the conversational identity path instead of guessing from stale work context.";
  }
  if (signals.lightweightConversation) {
    return "Hey.";
  }
  if (signals.interpersonalConversation) {
    return "Okay.";
  }
  return "I'm here, but direct conversation synthesis is unavailable in this environment right now.";
}
