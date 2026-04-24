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

const RELATIONSHIP_INVENTORY_TERMS = new Set([
  "people",
  "ppl",
  "folks",
  "anyone"
]);

const EVENT_PARTICIPANT_RECALL_TERMS = new Set([
  "sold",
  "bought",
  "handled",
  "paperwork",
  "happened"
]);

const DURABLE_MEMORY_RECALL_TERMS = new Set([
  "active",
  "billing",
  "cleanup",
  "current",
  "currently",
  "date",
  "dates",
  "employment",
  "fact",
  "facts",
  "handles",
  "handling",
  "historical",
  "milestone",
  "pending",
  "review",
  "tentative"
]);

const RUNTIME_STATUS_REFERENCE_TERMS = new Set([
  "browser",
  "browsers",
  "closed",
  "desktop",
  "open",
  "page",
  "pages",
  "project",
  "projects",
  "tab",
  "tabs",
  "window",
  "windows"
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
 * Returns whether the turn includes a typo-tolerant "remember" cue.
 *
 * @param rawTokens - Normalized surface tokens from the current user wording.
 * @returns `true` when one token still clearly points at "remember".
 */
function hasApproximateRememberCue(rawTokens: readonly string[]): boolean {
  return rawTokens.some((token) => token === "remember" || /^rem[a-z]{2,}$/.test(token));
}

/**
 * Returns whether the wording is asking for a broad people-inventory recall.
 *
 * @param rawTokens - Normalized surface tokens from the current user wording.
 * @param questionLike - Whether the turn structurally reads as a question.
 * @returns `true` when the wording is a people-I-know style relationship inventory prompt.
 */
function isRelationshipInventoryRecallShape(
  rawTokens: readonly string[],
  questionLike: boolean
): boolean {
  if (!questionLike) {
    return false;
  }
  if (!rawTokens.includes("who")) {
    return false;
  }
  return (
    rawTokens.some((token) => RELATIONSHIP_INVENTORY_TERMS.has(token)) &&
    (rawTokens.includes("know") || hasApproximateRememberCue(rawTokens))
  );
}

/**
 * Returns whether one raw token is a contracted `who is` lead such as `who's`.
 *
 * @param token - Raw normalized surface token.
 * @returns `true` when the token carries a contracted `who is` shape.
 */
function isContractedWhoIsLeadToken(token: string): boolean {
  return token === "who's" || token === "whos";
}

/**
 * Returns whether the current wording is asking for bounded event-memory recall rather than
 * workflow/status continuity.
 *
 * **Why it exists:**
 * Phase 8 needs ordinary-chat participant-role and event-summary prompts such as
 * `Who sold Jordan the gray Accord?` to stay on the direct memory path without adding a parallel
 * routing surface separate from relationship recall.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param rawTokens - Normalized surface tokens from the current user wording.
 * @param questionLike - Whether the turn structurally reads as a question.
 * @returns `true` when the wording is a bounded event-memory recall prompt.
 */
function isEventMemoryRecallShape(
  rawTokens: readonly string[],
  questionLike: boolean
): boolean {
  if (!questionLike) {
    return false;
  }
  if (!rawTokens.some((token) => EVENT_PARTICIPANT_RECALL_TERMS.has(token))) {
    return false;
  }
  if (rawTokens.includes("who") && hasSpecificRelationshipSubjectToken(rawTokens)) {
    return true;
  }
  return (
    rawTokens.includes("what") &&
    rawTokens.includes("happened") &&
    hasSpecificRelationshipSubjectToken(rawTokens)
  );
}

/**
 * Counts cue matches.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param rawTokens - Input consumed by this helper.
 * @param cues - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function countCueMatches(
  rawTokens: readonly string[],
  cues: ReadonlySet<string>
): number {
  let matches = 0;
  for (const token of rawTokens) {
    if (cues.has(token)) {
      matches += 1;
    }
  }
  return matches;
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
  if (isEventMemoryRecallShape(rawTokens, signals.questionLike)) {
    return true;
  }
  if (isRelationshipInventoryRecallShape(rawTokens, signals.questionLike)) {
    return true;
  }
  if (
    signals.questionLike &&
    rawTokens.includes("do") &&
    rawTokens.includes("you") &&
    rawTokens.includes("know") &&
    !signals.referencesSelf &&
    !signals.containsNameConcept &&
    hasSpecificRelationshipSubjectToken(rawTokens)
  ) {
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
  const contractedWhoIndex = rawTokens.findIndex((token) => isContractedWhoIsLeadToken(token));
  if (signals.questionLike && contractedWhoIndex >= 0) {
    const subjectToken = rawTokens[contractedWhoIndex + 1] ?? "";
    if (subjectToken && !NON_ENTITY_WHO_IS_TERMS.has(subjectToken)) {
      return true;
    }
  }
  if (
    signals.questionLike &&
    hasSpecificRelationshipSubjectToken(rawTokens)
  ) {
    const statusShapedRelationshipRecall =
      hasApproximateRememberCue(rawTokens) ||
      rawTokens.includes("again") ||
      (
        rawTokens.includes("going") &&
        rawTokens.includes("with") &&
        (
          rawTokens.includes("what") ||
          rawTokens.includes("what's")
        )
      ) ||
      (
        rawTokens.includes("work") &&
        rawTokens.includes("with") &&
        (
          rawTokens.includes("who") ||
          rawTokens.includes("did") ||
          rawTokens.includes("before") ||
          rawTokens.includes("bfore")
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

/**
 * Returns whether the user is asking for a combined durable-memory recap plus runtime/browser
 * status update that should stay on the conversational answer path instead of collapsing to the
 * thin inline status renderer.
 *
 * @param userInput - Raw current user wording.
 * @returns `true` when the wording mixes memory recall with browser/runtime status.
 */
export function isMixedConversationMemoryStatusRecallTurn(
  userInput: string
): boolean {
  const normalized = normalizeConversationChatTurnWhitespace(userInput);
  if (!normalized) {
    return false;
  }
  const rawTokens = collectConversationChatTurnRawTokens(normalized);
  const signals = analyzeConversationChatTurnSignals(normalized);
  if (!signals.questionLike && !rawTokens.includes("tell")) {
    return false;
  }
  const durableMemoryCueCount = countCueMatches(rawTokens, DURABLE_MEMORY_RECALL_TERMS);
  const runtimeStatusCueCount = countCueMatches(rawTokens, RUNTIME_STATUS_REFERENCE_TERMS);
  const asksForDurableMemoryRecall =
    signals.containsRelationshipCue ||
    durableMemoryCueCount >= 2 ||
    (
      rawTokens.includes("current") &&
      (
        rawTokens.includes("historical") ||
        rawTokens.includes("pending") ||
        rawTokens.includes("tentative")
      )
    );
  const asksForRuntimeStatus =
    signals.containsStatusCue &&
    (
      signals.referencesArtifact ||
      runtimeStatusCueCount >= 2 ||
      rawTokens.includes("open") ||
      rawTokens.includes("closed")
    );
  return asksForDurableMemoryRecall && asksForRuntimeStatus;
}
