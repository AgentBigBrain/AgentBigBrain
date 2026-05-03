/**
 * @fileoverview Shared deterministic validation and session-context helpers for model-assisted self-identity interpretation.
 */

import { validatePreferredNameCandidateValue } from "../../core/profileMemoryRuntime/profileMemoryExtraction";
import type { ProfileValidatedFactCandidateInput } from "../../core/profileMemoryRuntime/contracts";
import type { ConversationSession } from "../sessionStore";
import { normalizeWhitespace } from "../conversationManagerHelpers";
import {
  analyzeConversationChatTurnSignals,
  type IdentityInterpretationEligibilityReason
} from "./chatTurnSignals";

/**
 * Returns the latest assistant-authored conversational turn for bounded identity interpretation.
 *
 * @param session - Conversation session carrying recent turns.
 * @returns Most recent assistant text, or `null` when none exists.
 */
export function resolveRecentAssistantTurn(
  session: ConversationSession
): string | null {
  return [...session.conversationTurns]
    .reverse()
    .find((turn) => turn.role === "assistant")
    ?.text ?? null;
}

/**
 * Validates a model-proposed preferred-name candidate using the deterministic extractor as the
 * final normalization and safety gate.
 *
 * @param candidateValue - Raw candidate name returned by the identity interpreter.
 * @returns Canonical preferred name when safe, otherwise `null`.
 */
export function validateInterpretedPreferredNameCandidate(
  candidateValue: string | null
): string | null {
  return validatePreferredNameCandidateValue(normalizeWhitespace(candidateValue ?? ""));
}

/**
 * Builds the typed profile-memory fact candidate used for preferred-name persistence.
 *
 * @param preferredName - Validated preferred-name value.
 * @param confidence - Candidate confidence assigned by the identity interpreter or fast path.
 * @returns Canonical validated fact candidate, or `null` when the value is unsafe.
 */
export function buildPreferredNameValidatedFactCandidate(
  preferredName: string,
  confidence: number
): ProfileValidatedFactCandidateInput | null {
  const validatedPreferredName = validateInterpretedPreferredNameCandidate(preferredName);
  if (!validatedPreferredName) {
    return null;
  }
  return {
    key: "identity.preferred_name",
    candidateValue: validatedPreferredName,
    source: "conversation.identity_interpretation",
    confidence
  };
}

/**
 * Builds the bounded fail-closed reply when ambiguous identity wording could not be interpreted
 * safely enough to persist or answer from.
 *
 * @param reason - Eligibility reason that led the turn onto the identity interpretation path.
 * @returns Stable direct-chat clarification reply.
 */
export function buildIdentityInterpretationFallbackReply(
  reason: IdentityInterpretationEligibilityReason
): string {
  if (
    reason === "explicit_self_identity_declaration" ||
    reason === "plausible_self_identity_declaration"
  ) {
    return "If you're telling me your name, say it in a short direct form like \"My name is Avery.\" and I'll remember it.";
  }
  return "If you want me to answer or remember your name, ask directly or tell me in a short form like \"My name is Avery.\"";
}

/**
 * Returns whether a self-identity declaration is short and explicit enough to stay on the
 * deterministic fast path without semantic model help.
 *
 * @param userInput - Raw current user wording.
 * @returns `true` when the declaration is short, explicit, and bounded.
 */
export function isSimpleDeterministicSelfIdentityDeclaration(
  userInput: string
): boolean {
  const signals = analyzeConversationChatTurnSignals(userInput);
  return (
    signals.primaryKind === "self_identity_statement" &&
    signals.rawTokenCount <= 6 &&
    signals.meaningfulTerms.length <= 6
  );
}
