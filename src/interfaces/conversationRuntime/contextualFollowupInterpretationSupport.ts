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
const SOFT_CONTEXTUAL_FOLLOWUP_TERMS = new Set([
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
const CONTEXTUAL_MEANING_TERMS = new Set([
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
const NON_ANCHOR_CONTEXTUAL_FOLLOWUP_TERMS = new Set([
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
 * Resolves one deterministic contextual follow-up fast path from lexical evidence alone.
 *
 * @param userInput - Raw current user wording.
 * @returns Canonical intent-mode result when lexical evidence is already sufficient, otherwise `null`.
 */
export function resolveDeterministicContextualFollowupIntent(
  userInput: string
): ResolvedConversationIntentMode | null {
  if (hasTurnLocalFirstPersonStatusUpdate(userInput)) {
    return null;
  }
  const lexicalClassification = classifyContextualFollowupLexicalCue(userInput);
  if (!lexicalClassification.cueDetected || lexicalClassification.conflict) {
    return null;
  }

  const normalized = userInput.trim();
  if (!normalized) {
    return null;
  }
  const turnSignals = analyzeConversationChatTurnSignals(normalized);
  const rawTokens = collectConversationChatTurnRawTokens(normalized);
  const hasMeaningCue =
    rawTokens.some((token) => CONTEXTUAL_MEANING_TERMS.has(token)) ||
    turnSignals.meaningfulTerms.some((term) => CONTEXTUAL_MEANING_TERMS.has(term));
  if (
    turnSignals.primaryKind === "approval_or_control" ||
    turnSignals.primaryKind === "self_identity_query" ||
    turnSignals.primaryKind === "self_identity_statement" ||
    turnSignals.primaryKind === "assistant_identity_query"
  ) {
    return null;
  }

  if (/\bremind me\b/i.test(normalized) && lexicalClassification.candidateTokens.length > 0) {
    return buildContextualFollowupIntentMode(
      "reminder_followup",
      lexicalClassification.confidenceTier === "HIGH" ? "high" : "medium",
      "The user explicitly asked for a later reminder about an existing topic.",
      "intent_mode_contextual_followup_reminder_lexical"
    );
  }

  if (
    hasMeaningCue &&
    lexicalClassification.confidenceTier === "HIGH" &&
    lexicalClassification.candidateTokens.length > 0
  ) {
    return buildContextualFollowupIntentMode(
      "status_followup",
      "medium",
      "The user explicitly asked for a later status or check-in about an existing topic.",
      "intent_mode_contextual_followup_status_lexical"
    );
  }

  return null;
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
  routingClassification: RoutingMapClassificationV1 | null
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

  const turnSignals = analyzeConversationChatTurnSignals(normalized);
  const rawTokens = collectConversationChatTurnRawTokens(normalized);
  if (
    turnSignals.primaryKind === "self_identity_query" ||
    turnSignals.primaryKind === "self_identity_statement" ||
    turnSignals.primaryKind === "assistant_identity_query" ||
    turnSignals.primaryKind === "approval_or_control" ||
    turnSignals.containsWorkflowCue
  ) {
    return false;
  }

  const lexicalClassification = classifyContextualFollowupLexicalCue(normalized);
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
 * Resolves one bounded contextual follow-up intent classification ahead of the generic local
 * intent-model tie-breaker.
 *
 * Deterministic lexical fast paths win first. Ambiguous contextual follow-up leftovers may then
 * use the dedicated shared interpreter. When that interpreter is unavailable or low-confidence,
 * the caller should preserve the deterministic result instead of falling through to generic
 * execution reinterpretation.
 */
export async function resolveContextualFollowupIntentResolution(
  userInput: string,
  deterministicResolution: ResolvedConversationIntentMode,
  routingClassification: RoutingMapClassificationV1 | null,
  sessionHints: LocalIntentModelSessionHints | null,
  contextualFollowupInterpretationResolver?: ContextualFollowupInterpretationResolver
): Promise<ContextualFollowupIntentResolution> {
  const deterministicIntent = resolveDeterministicContextualFollowupIntent(userInput);
  if (deterministicIntent) {
    return {
      resolvedIntentMode: deterministicIntent,
      preserveDeterministic: false
    };
  }

  if (
    !isEligibleForContextualFollowupInterpretation(
      userInput,
      deterministicResolution,
      routingClassification
    )
  ) {
    return {
      resolvedIntentMode: null,
      preserveDeterministic: false
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
