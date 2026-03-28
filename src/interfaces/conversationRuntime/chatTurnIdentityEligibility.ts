/**
 * @fileoverview Identity-interpretation eligibility and identity-context follow-up helpers.
 */

import {
  analyzeConversationChatTurnSignals,
  collectConversationChatTurnRawTokens,
  normalizeConversationChatTurnWhitespace,
  type ConversationChatTurnSignals
} from "./chatTurnSignalAnalysis";

export type IdentityInterpretationEligibilityReason =
  | "self_identity_query"
  | "assistant_identity_query"
  | "explicit_self_identity_declaration"
  | "plausible_self_identity_declaration"
  | "identity_follow_up";

export interface IdentityInterpretationEligibilityContext {
  recentIdentityConversationActive?: boolean;
  recentAssistantIdentityPrompt?: boolean;
  recentAssistantIdentityAnswer?: boolean;
}

export interface IdentityContextRecentTurn {
  role: "user" | "assistant";
  text: string;
}

export interface IdentityInterpretationEligibility {
  eligible: boolean;
  ambiguous: boolean;
  reason: IdentityInterpretationEligibilityReason | null;
}

/**
 * Returns whether one bounded token sequence appears contiguously inside the raw token list.
 *
 * **Why it exists:**
 * Identity eligibility still needs a narrow ordered-token check for low-ambiguity declaration
 * shapes without falling back to discourse-tail regex cleanup.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param rawTokens - Surface token sequence for the current turn.
 * @param sequence - Candidate normalized token sequence that must appear contiguously.
 * @returns `true` when the sequence appears contiguously.
 */
function hasTokenSequence(
  rawTokens: readonly string[],
  sequence: readonly string[]
): boolean {
  if (sequence.length === 0 || sequence.length > rawTokens.length) {
    return false;
  }
  for (let index = 0; index <= rawTokens.length - sequence.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (rawTokens[index + offset] !== sequence[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return true;
    }
  }
  return false;
}

/**
 * Returns whether the turn plausibly contains a self-identity declaration that should stay on the
 * conversational identity path even when the exact value still needs later semantic interpretation.
 *
 * **Why it exists:**
 * Mixed turns like `I already told you my name is Avery several times` should remain eligible
 * for the identity interpreter without widening the model path to workflow or artifact wording.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param rawTokens - Surface token sequence for the current turn.
 * @param signals - Structural turn signals for the current turn.
 * @returns `true` when the wording plausibly declares self identity.
 */
function hasPlausibleSelfIdentityDeclarationShape(
  rawTokens: readonly string[],
  signals: ConversationChatTurnSignals
): boolean {
  if (
    signals.questionLike ||
    !signals.referencesSelf ||
    !signals.containsNameConcept ||
    signals.referencesArtifact ||
    signals.containsWorkflowCue ||
    signals.containsStatusCue
  ) {
    return false;
  }
  return (
    rawTokens.length >= 3 &&
    rawTokens.length <= 16 &&
    signals.meaningfulTerms.length <= 10 &&
    (
      hasTokenSequence(rawTokens, ["my", "name", "is"]) ||
      hasTokenSequence(rawTokens, ["call", "me"]) ||
      hasTokenSequence(rawTokens, ["i", "go", "by"]) ||
      rawTokens[0] === "i'm" ||
      hasTokenSequence(rawTokens, ["i", "am"])
    )
  );
}

/**
 * Returns whether a short conversational follow-up should stay on the identity path because the
 * immediately surrounding conversation is already identity-focused.
 *
 * **Why it exists:**
 * Short replies like `No` or `okay` become dangerous when stale workflow continuity exists. This
 * helper keeps those turns on the conversational path only when recent identity context makes that
 * interpretation plausible.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param signals - Structural turn signals for the current turn.
 * @param context - Optional recent identity-context hints from the session.
 * @returns `true` when the turn is a bounded identity follow-up candidate.
 */
function isIdentityFollowUpCandidate(
  signals: ConversationChatTurnSignals,
  context: IdentityInterpretationEligibilityContext
): boolean {
  if (
    context.recentIdentityConversationActive !== true &&
    context.recentAssistantIdentityPrompt !== true
  ) {
    return false;
  }
  if (
    signals.referencesArtifact ||
    signals.containsWorkflowCue ||
    signals.containsStatusCue
  ) {
    return false;
  }
  return (
    signals.primaryKind === "approval_or_control" ||
    (signals.primaryKind === "plain_chat" && signals.rawTokenCount > 0 && signals.rawTokenCount <= 4)
  );
}

/**
 * Returns whether a turn is eligible for the bounded identity-interpretation task.
 *
 * **Why it exists:**
 * The shared conversational interpreter should only run on a narrow identity-shaped band, not on
 * every chat turn. This helper centralizes that eligibility policy.
 *
 * **What it talks to:**
 * - Uses `analyzeConversationChatTurnSignals`, `collectConversationChatTurnRawTokens`, and
 *   `normalizeConversationChatTurnWhitespace` from `./chatTurnSignalAnalysis`.
 * - Uses local constants/helpers within this module.
 *
 * @param userInput - Raw current user wording.
 * @param context - Optional recent identity-context hints from session state.
 * @returns Eligibility metadata for the shared identity interpretation task.
 */
export function assessIdentityInterpretationEligibility(
  userInput: string,
  context: IdentityInterpretationEligibilityContext = {}
): IdentityInterpretationEligibility {
  const signals = analyzeConversationChatTurnSignals(userInput);
  if (signals.primaryKind === "self_identity_query") {
    return {
      eligible: true,
      ambiguous: false,
      reason: "self_identity_query"
    };
  }
  if (signals.primaryKind === "assistant_identity_query") {
    return {
      eligible: true,
      ambiguous: false,
      reason: "assistant_identity_query"
    };
  }
  if (signals.primaryKind === "self_identity_statement") {
    return {
      eligible: true,
      ambiguous: false,
      reason: "explicit_self_identity_declaration"
    };
  }

  const normalized = normalizeConversationChatTurnWhitespace(userInput);
  const rawTokens = collectConversationChatTurnRawTokens(normalized);
  if (hasPlausibleSelfIdentityDeclarationShape(rawTokens, signals)) {
    return {
      eligible: true,
      ambiguous: true,
      reason: "plausible_self_identity_declaration"
    };
  }

  if (isIdentityFollowUpCandidate(signals, context)) {
    return {
      eligible: true,
      ambiguous: true,
      reason: "identity_follow_up"
    };
  }

  return {
    eligible: false,
    ambiguous: false,
    reason: null
  };
}

/**
 * Returns whether the latest assistant turn likely prompted the user for their own identity.
 *
 * **Why it exists:**
 * The routing layer only needs a bounded session hint here. It should not infer full identity
 * semantics from assistant text, but it does need to know when a short reply like `No` is likely
 * answering a recent name prompt rather than a workflow question.
 *
 * **What it talks to:**
 * - Uses `analyzeConversationChatTurnSignals` from `./chatTurnSignalAnalysis`.
 *
 * @param assistantText - Most recent assistant-authored conversational turn.
 * @returns `true` when the assistant likely asked about the user's own identity or name.
 */
export function isLikelyAssistantIdentityPrompt(assistantText: string): boolean {
  const signals = analyzeConversationChatTurnSignals(assistantText);
  if (
    signals.referencesArtifact ||
    signals.containsWorkflowCue ||
    signals.containsStatusCue
  ) {
    return false;
  }
  return (
    signals.questionLike &&
    signals.referencesAssistant &&
    signals.containsNameConcept
  );
}

/**
 * Returns whether the latest assistant turn likely answered "who are you?" with a direct
 * self-identifying statement.
 *
 * @param assistantText - Most recent assistant-authored conversational turn.
 * @returns `true` when the assistant likely just identified itself directly.
 */
export function isLikelyAssistantIdentityAnswer(assistantText: string): boolean {
  const signals = analyzeConversationChatTurnSignals(assistantText);
  if (
    signals.questionLike ||
    signals.referencesArtifact ||
    signals.containsWorkflowCue ||
    signals.containsStatusCue
  ) {
    return false;
  }
  const rawTokens = collectConversationChatTurnRawTokens(
    normalizeConversationChatTurnWhitespace(assistantText)
  );
  return (
    signals.referencesSelf &&
    rawTokens.length >= 2 &&
    rawTokens.length <= 5 &&
    (
      rawTokens[0] === "i'm" ||
      hasTokenSequence(rawTokens, ["i", "am"])
    )
  );
}

/**
 * Builds the bounded recent-turn identity context shared by direct-chat preservation and optional
 * model eligibility checks.
 *
 * **Why it exists:**
 * Several routing surfaces need the same recent identity context, and recomputing it ad hoc in
 * each caller risks diverging behavior between direct chat, no-worker fallbacks, and continuity
 * guards.
 *
 * **What it talks to:**
 * - Uses `isLikelyAssistantIdentityPrompt`, `isLikelyAssistantIdentityAnswer`, and
 *   `assessIdentityInterpretationEligibility` from this module.
 *
 * @param recentTurns - Small trailing slice of recent conversation turns.
 * @returns Shared identity-context hints derived from those turns.
 */
export function buildRecentIdentityInterpretationContext(
  recentTurns: readonly IdentityContextRecentTurn[]
): IdentityInterpretationEligibilityContext {
  const hasRecentAssistantIdentityPrompt = recentTurns.some(
    (turn) => turn.role === "assistant" && isLikelyAssistantIdentityPrompt(turn.text)
  );
  const recentAssistantIdentityAnswer = recentTurns.some(
    (turn) => turn.role === "assistant" && isLikelyAssistantIdentityAnswer(turn.text)
  );
  const recentIdentityConversationActive = recentTurns.some((turn) => {
    if (turn.role === "assistant") {
      return isLikelyAssistantIdentityPrompt(turn.text);
    }
    const eligibility = assessIdentityInterpretationEligibility(turn.text);
    return (
      eligibility.eligible &&
      eligibility.reason !== "assistant_identity_query"
    );
  });

  return {
    recentAssistantIdentityPrompt: hasRecentAssistantIdentityPrompt,
    recentAssistantIdentityAnswer,
    recentIdentityConversationActive
  };
}

/**
 * Returns whether a deterministic chat turn should stay on the direct-conversation surface even if
 * stale workflow context exists elsewhere in the session.
 *
 * **Why it exists:**
 * Direct conversation should preserve lightweight identity turns and bounded identity follow-ups
 * before the execution-intent model gets a chance to reinterpret them under stale workflow state.
 *
 * **What it talks to:**
 * - Uses `analyzeConversationChatTurnSignals` from `./chatTurnSignalAnalysis`.
 * - Uses `assessIdentityInterpretationEligibility` from `./chatTurnIdentityEligibility`.
 *
 * @param userInput - Raw current user wording.
 * @param context - Optional recent identity-context hints from session state.
 * @returns `true` when the turn is conversational rather than actionable workflow recall.
 */
export function shouldPreserveDeterministicDirectChatTurn(
  userInput: string,
  context: IdentityInterpretationEligibilityContext = {}
): boolean {
  const signals = analyzeConversationChatTurnSignals(userInput);
  const identityEligibility = assessIdentityInterpretationEligibility(userInput, context);
  return (
    signals.lightweightConversation ||
    (signals.interpersonalConversation && context.recentAssistantIdentityAnswer === true) ||
    identityEligibility.eligible
  );
}
