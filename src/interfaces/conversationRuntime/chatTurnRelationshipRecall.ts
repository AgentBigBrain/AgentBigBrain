/**
 * @fileoverview Bounded relationship-recall detection for conversational routing.
 */

import {
  analyzeConversationChatTurnSignals,
  collectConversationChatTurnRawTokens,
  normalizeConversationChatTurnWhitespace
} from "./chatTurnSignalAnalysis";

const NON_ENTITY_WHO_IS_TERMS = new Set([
  "a",
  "an",
  "the",
  "this",
  "that",
  "it",
  "there",
  "doing",
  "going"
]);

/**
 * Returns whether the turn is a bounded relationship-summary or relationship-reference question
 * that should stay on the conversational path instead of inheriting stale workflow continuity.
 *
 * @param userInput - Raw current user wording.
 * @returns `true` when the wording is a relationship-focused conversational recall turn.
 */
export function isRelationshipConversationRecallTurn(userInput: string): boolean {
  const normalized = normalizeConversationChatTurnWhitespace(userInput);
  if (!normalized) {
    return false;
  }
  const rawTokens = collectConversationChatTurnRawTokens(normalized);
  const signals = analyzeConversationChatTurnSignals(normalized);
  if (
    signals.containsWorkflowCue ||
    signals.referencesArtifact
  ) {
    return false;
  }
  if (signals.containsApprovalCue && !signals.questionLike) {
    return false;
  }
  const hasExplainCue =
    rawTokens.includes("explain") ||
    rawTokens.includes("reexplain") ||
    rawTokens.includes("summarize") ||
    rawTokens.includes("describe") ||
    (rawTokens.includes("re") && rawTokens.includes("explain"));
  if (signals.containsRelationshipCue && hasExplainCue) {
    return true;
  }
  if (
    rawTokens.includes("who") &&
    rawTokens.includes("is") &&
    rawTokens.some((token) => token === "he" || token === "she" || token === "they")
  ) {
    return true;
  }
  const whoIndex = rawTokens.indexOf("who");
  if (
    signals.questionLike &&
    whoIndex >= 0 &&
    rawTokens[whoIndex + 1] === "is"
  ) {
    const subjectToken = rawTokens[whoIndex + 2] ?? "";
    if (subjectToken && !NON_ENTITY_WHO_IS_TERMS.has(subjectToken)) {
      return true;
    }
  }
  return signals.containsRelationshipCue && signals.containsStatusCue && rawTokens.includes("who");
}
