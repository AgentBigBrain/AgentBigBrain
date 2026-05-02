/**
 * @fileoverview Bounded contextual follow-up intent support shared by front-door intent resolution.
 */

import type {
  ContextualFollowupInterpretationResolver,
  LocalIntentModelSessionHints
} from "../../organs/languageUnderstanding/localIntentModelContracts";
import { routeContextualFollowupInterpretationModel } from "../../organs/languageUnderstanding/localIntentModelRouter";
import type { RoutingMapClassificationV1 } from "../routingMap";
import { classifyContextualFollowupLexicalCue } from "../contextualFollowupLexicalClassifier";
import {
  analyzeConversationChatTurnSignals,
  collectConversationChatTurnRawTokens
} from "./chatTurnSignalAnalysis";
import type { ResolvedConversationIntentMode } from "./intentModeContracts";
import { hasTurnLocalFirstPersonStatusUpdate } from "./turnLocalStatusUpdate";

const CONTEXTUAL_FOLLOWUP_MAX_INPUT_CHARS = 120;
const CONTEXTUAL_FOLLOWUP_MAX_INPUT_TOKENS = 10;
const SOFT_CONTEXTUAL_FOLLOWUP_TERMS = new Set([ // lexical-boundary: candidate-only
  "later",
  "posted",
  "update",
  "status",
  "remind",
  "follow",
  "followup",
  "check",
  "resolve",
  "progress"
]);
const CONTEXTUAL_MEANING_TERMS = new Set([ // lexical-boundary: candidate-only
  "posted",
  "update",
  "status",
  "remind",
  "follow",
  "followup",
  "check",
  "resolve",
  "progress"
]);
const NON_ANCHOR_CONTEXTUAL_FOLLOWUP_TERMS = new Set([ // lexical-boundary: candidate-only
  ...SOFT_CONTEXTUAL_FOLLOWUP_TERMS,
  "keep",
  "know",
  "how",
  "hows",
  "is",
  "on",
  "about",
  "the",
  "me"
]);
const EXPLICIT_REMINDER_FOLLOWUP_TERMS = new Set(["remind", "reminder"]); // lexical-boundary: exact

export interface ContextualFollowupIntentResolution {
  resolvedIntentMode: ResolvedConversationIntentMode | null;
  preserveDeterministic: boolean;
}

/**
 * Counts bounded whitespace-separated tokens for contextual follow-up eligibility checks.
 *
 * @param value - Raw user wording under evaluation.
 * @returns Number of whitespace-separated tokens after normalization.
 */
function countWhitespaceTokens(value: string): number {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return 0;
  }
  return normalized.split(" ").length;
}

/**
 * Returns whether session state provides a typed continuation anchor for contextual follow-up.
 *
 * **Why it exists:**
 * Cue words like "later" or "status" should not create workflow or memory continuation on their
 * own. They need current conversation state unless the request is an explicit reminder command.
 *
 * **What it talks to:**
 * - Uses `LocalIntentModelSessionHints` (import `LocalIntentModelSessionHints`) from
 *   `../../organs/languageUnderstanding/localIntentModelContracts`.
 *
 * @param sessionHints - Current typed session hints from the conversation runtime.
 * @returns `true` when follow-up interpretation has a live typed anchor.
 */
function hasTypedContextualFollowupAnchor(
  sessionHints: LocalIntentModelSessionHints | null
): boolean {
  return (
    sessionHints?.hasReturnHandoff === true ||
    sessionHints?.workflowContinuityActive === true ||
    sessionHints?.domainContinuityActive === true ||
    sessionHints?.modeContinuity !== null && sessionHints?.modeContinuity !== undefined
  );
}

/**
 * Returns whether the current turn is an explicit reminder request.
 *
 * **Why it exists:**
 * Reminder commands may be handled without existing workflow continuity, while softer status
 * follow-up cues should require typed session context.
 *
 * **What it talks to:**
 * - Uses local exact reminder terms within this module.
 *
 * @param rawTokens - Tokenized current user wording.
 * @returns `true` when the turn explicitly asks for a reminder.
 */
function isExplicitReminderFollowup(rawTokens: readonly string[]): boolean {
  return (
    rawTokens.some((token) => EXPLICIT_REMINDER_FOLLOWUP_TERMS.has(token)) &&
    rawTokens.includes("me")
  );
}

/**
 * Builds the bounded intent-mode resolution used when contextual follow-up meaning is already
 * known.
 *
 * @param kind - Canonical contextual follow-up meaning.
 * @param confidence - Confidence associated with the bounded interpretation.
 * @param explanation - Short explanation surfaced for auditing and tests.
 * @param matchedRuleId - Stable identifier describing the resolution path.
 * @returns Canonical intent-mode result for routing.
 */
function buildContextualFollowupIntentMode(
  kind: "status_followup" | "reminder_followup",
  confidence: "low" | "medium" | "high",
  explanation: string,
  matchedRuleId: string
): ResolvedConversationIntentMode {
  if (kind === "status_followup") {
    return {
      mode: "status_or_recall",
      confidence,
      matchedRuleId,
      explanation,
      clarification: null
    };
  }
  return {
    mode: "chat",
    confidence,
    matchedRuleId,
    explanation,
    clarification: null
  };
}

/**
 * Returns whether a chat-mode turn is eligible for bounded contextual follow-up interpretation.
 *
 * @param userInput - Raw current user wording.
 * @param deterministicResolution - Current deterministic front-door result.
 * @param routingClassification - Optional deterministic routing hint for the same turn.
 * @returns `true` when the bounded contextual follow-up interpreter may safely run.
 */
function isEligibleForContextualFollowupInterpretation(
  userInput: string,
  deterministicResolution: ResolvedConversationIntentMode,
  routingClassification: RoutingMapClassificationV1 | null,
  sessionHints: LocalIntentModelSessionHints | null
): boolean {
  if (deterministicResolution.mode !== "chat") {
    return false;
  }
  if (hasTurnLocalFirstPersonStatusUpdate(userInput)) {
    return false;
  }

  const normalized = userInput.trim();
  if (!normalized || normalized.includes("\n")) {
    return false;
  }
  if (normalized.length > CONTEXTUAL_FOLLOWUP_MAX_INPUT_CHARS) {
    return false;
  }
  const tokenCount = countWhitespaceTokens(normalized);
  if (tokenCount === 0 || tokenCount > CONTEXTUAL_FOLLOWUP_MAX_INPUT_TOKENS) {
    return false;
  }
  if (
    routingClassification?.routeType === "execution_surface" &&
    routingClassification.commandIntent !== null
  ) {
    return false;
  }

  const lexicalClassification = classifyContextualFollowupLexicalCue(normalized);
  const turnSignals = analyzeConversationChatTurnSignals(normalized);
  const rawTokens = collectConversationChatTurnRawTokens(normalized);
  if (
    turnSignals.primaryKind === "self_identity_query" ||
    turnSignals.primaryKind === "self_identity_statement" ||
    turnSignals.primaryKind === "assistant_identity_query" ||
    turnSignals.primaryKind === "approval_or_control"
  ) {
    return false;
  }
  if (turnSignals.containsWorkflowCue && !lexicalClassification.cueDetected) {
    return false;
  }
  if (
    !hasTypedContextualFollowupAnchor(sessionHints) &&
    !isExplicitReminderFollowup(rawTokens)
  ) {
    return false;
  }
  if (lexicalClassification.cueDetected) {
    return true;
  }
  const hasMeaningCue =
    rawTokens.some((token) => CONTEXTUAL_MEANING_TERMS.has(token)) ||
    turnSignals.meaningfulTerms.some((term) => CONTEXTUAL_MEANING_TERMS.has(term));
  return hasMeaningCue;
}

/**
 * Builds bounded candidate topic-anchor tokens for the contextual follow-up interpreter.
 *
 * @param userInput - Raw current user wording.
 * @returns Deterministic topic-anchor seed tokens taken from the request itself.
 */
function buildContextualFollowupCandidateTokens(
  userInput: string
): readonly string[] {
  const lexicalClassification = classifyContextualFollowupLexicalCue(userInput);
  if (lexicalClassification.candidateTokens.length > 0) {
    return lexicalClassification.candidateTokens;
  }
  const turnSignals = analyzeConversationChatTurnSignals(userInput);
  return turnSignals.meaningfulTerms
    .filter((term) => !NON_ANCHOR_CONTEXTUAL_FOLLOWUP_TERMS.has(term))
    .slice(0, 4);
}

/**
 * Returns whether a chat turn has contextual follow-up wording that should not fall through to
 * generic execution interpretation.
 *
 * **Why it exists:**
 * When a turn says things like "keep me posted" without typed session context, the safe default is
 * ordinary chat. Letting the generic local intent model reinterpret that wording can recreate the
 * broad lexical authority this cleanup is removing.
 *
 * @param userInput - Raw current user wording.
 * @param routingClassification - Optional deterministic routing hint for the same turn.
 * @returns `true` when deterministic chat should be preserved instead of calling generic intent.
 */
function hasUnanchoredContextualFollowupCueShape(
  userInput: string,
  routingClassification: RoutingMapClassificationV1 | null
): boolean {
  if (hasTurnLocalFirstPersonStatusUpdate(userInput)) {
    return false;
  }
  if (
    routingClassification?.routeType === "execution_surface" &&
    routingClassification.commandIntent !== null
  ) {
    return false;
  }

  const normalized = userInput.trim();
  if (!normalized || normalized.includes("\n")) {
    return false;
  }
  if (normalized.length > CONTEXTUAL_FOLLOWUP_MAX_INPUT_CHARS) {
    return false;
  }
  const tokenCount = countWhitespaceTokens(normalized);
  if (tokenCount === 0 || tokenCount > CONTEXTUAL_FOLLOWUP_MAX_INPUT_TOKENS) {
    return false;
  }

  const lexicalClassification = classifyContextualFollowupLexicalCue(normalized);
  if (lexicalClassification.cueDetected) {
    return true;
  }

  const turnSignals = analyzeConversationChatTurnSignals(normalized);
  const rawTokens = collectConversationChatTurnRawTokens(normalized);
  return (
    rawTokens.some((token) => CONTEXTUAL_MEANING_TERMS.has(token)) ||
    turnSignals.meaningfulTerms.some((term) => CONTEXTUAL_MEANING_TERMS.has(term))
  );
}

/**
 * Resolves one bounded contextual follow-up intent classification ahead of the generic local
 * intent-model tie-breaker.
 *
 * Bounded lexical cues may make the dedicated shared interpreter eligible, but they do not choose
 * the final route. When that interpreter is unavailable or low-confidence, the caller should
 * preserve the deterministic result instead of falling through to generic execution
 * reinterpretation.
 */
export async function resolveContextualFollowupIntentResolution(
  userInput: string,
  deterministicResolution: ResolvedConversationIntentMode,
  routingClassification: RoutingMapClassificationV1 | null,
  sessionHints: LocalIntentModelSessionHints | null,
  contextualFollowupInterpretationResolver?: ContextualFollowupInterpretationResolver
): Promise<ContextualFollowupIntentResolution> {
  if (
    !isEligibleForContextualFollowupInterpretation(
      userInput,
      deterministicResolution,
      routingClassification,
      sessionHints
    )
  ) {
    return {
      resolvedIntentMode: null,
      preserveDeterministic: hasUnanchoredContextualFollowupCueShape(
        userInput,
        routingClassification
      )
    };
  }

  if (!contextualFollowupInterpretationResolver) {
    return {
      resolvedIntentMode: null,
      preserveDeterministic: true
    };
  }

  const signal = await routeContextualFollowupInterpretationModel(
    {
      userInput,
      routingClassification,
      sessionHints,
      deterministicCandidateTokens: buildContextualFollowupCandidateTokens(userInput)
    },
    contextualFollowupInterpretationResolver
  );
  if (!signal || signal.confidence === "low" || signal.kind === "uncertain") {
    return {
      resolvedIntentMode: null,
      preserveDeterministic: true
    };
  }
  if (signal.kind === "non_contextual_followup") {
    return {
      resolvedIntentMode: null,
      preserveDeterministic: false
    };
  }
  return {
    resolvedIntentMode: buildContextualFollowupIntentMode(
      signal.kind,
      signal.confidence,
      signal.explanation,
      `intent_mode_contextual_followup_${signal.kind}_model`
    ),
    preserveDeterministic: false
  };
}
