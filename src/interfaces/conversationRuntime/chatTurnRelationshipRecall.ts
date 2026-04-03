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

const GENERIC_RELATIONSHIP_RECALL_TERMS = new Set([
  "a",
  "about",
  "again",
  "an",
  "and",
  "are",
  "change",
  "changes",
  "do",
  "he",
  "her",
  "hers",
  "him",
  "his",
  "i",
  "is",
  "it",
  "its",
  "know",
  "me",
  "my",
  "of",
  "on",
  "our",
  "remember",
  "situation",
  "she",
  "status",
  "the",
  "their",
  "them",
  "they",
  "this",
  "those",
  "we",
  "what",
  "what's",
  "who",
  "with",
  "you",
  "your"
]);

/**
 * Returns whether the current wording carries a concrete person/topic token beyond generic recall
 * filler so short status-like relationship questions can stay on the conversational memory path.
 *
 * @param rawTokens - Normalized surface tokens from the current user wording.
 * @returns `true` when at least one token looks like a concrete recall subject.
 */
function hasSpecificRelationshipSubjectToken(rawTokens: readonly string[]): boolean {
  return rawTokens.some(
    (token) =>
      token.length >= 3 &&
      !GENERIC_RELATIONSHIP_RECALL_TERMS.has(token)
  );
}

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
  if (
    signals.referencesSelf &&
    rawTokens.includes("remember") &&
    !signals.containsRelationshipCue &&
    !rawTokens.includes("with") &&
    !rawTokens.includes("about") &&
    !rawTokens.includes("again")
  ) {
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
  if (
    signals.questionLike &&
    hasSpecificRelationshipSubjectToken(rawTokens)
  ) {
    const statusShapedRelationshipRecall =
      rawTokens.includes("remember") ||
      rawTokens.includes("again") ||
      (
        rawTokens.includes("going") &&
        rawTokens.includes("with") &&
        (
          rawTokens.includes("what") ||
          rawTokens.includes("what's")
        )
      ) ||
      (rawTokens.includes("about") && rawTokens.length <= 6) ||
      ((rawTokens.includes("status") || rawTokens.includes("situation")) &&
        (rawTokens.includes("with") ||
          rawTokens.some((token) => token.endsWith("'s"))));
    if (statusShapedRelationshipRecall) {
      return true;
    }
  }
  return signals.containsRelationshipCue && signals.containsStatusCue && rawTokens.includes("who");
}
