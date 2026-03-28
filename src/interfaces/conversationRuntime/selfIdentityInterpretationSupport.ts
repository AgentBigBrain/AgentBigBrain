/**
 * @fileoverview Shared deterministic validation and session-context helpers for model-assisted self-identity interpretation.
 */

import { validatePreferredNameCandidateValue } from "../../core/profileMemoryRuntime/profileMemoryExtraction";
import type { ConversationSession } from "../sessionStore";
import { normalizeWhitespace } from "../conversationManagerHelpers";
import {
  analyzeConversationChatTurnSignals,
  type IdentityInterpretationEligibilityReason
} from "./chatTurnSignals";

const CANONICAL_IDENTITY_DECLARATION_PREFIX = "My name is ";
const CANONICAL_IDENTITY_DECLARATION_SUFFIX = ".";

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
 * Builds a canonical direct identity declaration input from one validated preferred name.
 *
 * @param preferredName - Validated preferred-name value.
 * @returns Canonical declaration input suitable for the existing profile-memory seam.
 */
export function buildCanonicalIdentityDeclarationInput(
  preferredName: string
): string {
  return `${CANONICAL_IDENTITY_DECLARATION_PREFIX}${preferredName}${CANONICAL_IDENTITY_DECLARATION_SUFFIX}`;
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
