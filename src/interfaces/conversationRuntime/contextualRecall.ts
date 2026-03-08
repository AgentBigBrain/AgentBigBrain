/**
 * @fileoverview Owns bounded in-conversation contextual recall helpers for active user turns.
 */

import {
  buildConversationStackFromTurnsV1
} from "../../core/stage6_86ConversationStack";
import type {
  ConversationStackV1,
  ThreadFrameV1
} from "../../core/types";
import {
  isLikelyAssistantClarificationPrompt,
  normalizeWhitespace
} from "../conversationManagerHelpers";
import type {
  ConversationSession
} from "../sessionStore";

const MAX_CONTEXTUAL_RECALL_AGE_MS = 45 * 24 * 60 * 60 * 1000;
const MAX_SUPPORTING_CUE_CHARS = 180;
const RECENT_ASSISTANT_DUPLICATE_LOOKBACK = 4;
const MIN_TOPIC_LABEL_OVERLAP = 1;
const TOPIC_TOKEN_PATTERN = /[a-z0-9]+/g;
const TOPIC_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "any",
  "are",
  "back",
  "been",
  "but",
  "can",
  "did",
  "for",
  "from",
  "got",
  "had",
  "has",
  "have",
  "hey",
  "his",
  "her",
  "how",
  "into",
  "its",
  "just",
  "later",
  "like",
  "need",
  "next",
  "now",
  "our",
  "out",
  "same",
  "she",
  "that",
  "the",
  "them",
  "then",
  "they",
  "thing",
  "this",
  "those",
  "today",
  "want",
  "what",
  "when",
  "where",
  "with",
  "would",
  "your"
]);

export interface ContextualRecallCandidate {
  threadKey: string;
  topicLabel: string;
  supportingCue: string;
  openLoopCount: number;
  lastTouchedAt: string;
}

/**
 * Tokenizes freeform text into bounded lower-case topic terms for recall matching.
 *
 * @param value - Freeform text to tokenize.
 * @returns Stable set of meaningful topic tokens.
 */
function tokenizeTopicTerms(value: string): readonly string[] {
  const matches = normalizeWhitespace(value)
    .toLowerCase()
    .match(TOPIC_TOKEN_PATTERN) ?? [];
  const normalized = new Set<string>();
  for (const match of matches) {
    const token = match.trim();
    if (token.length < 3 || TOPIC_STOP_WORDS.has(token)) {
      continue;
    }
    normalized.add(token);
  }
  return [...normalized];
}

/**
 * Counts token overlap between the current user turn and a stored topic surface.
 *
 * @param left - Current user-turn tokens.
 * @param right - Thread/topic tokens to compare.
 * @returns Count of overlapping tokens.
 */
function countTokenOverlap(
  left: readonly string[],
  right: readonly string[]
): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const rightSet = new Set(right);
  let overlap = 0;
  for (const token of left) {
    if (rightSet.has(token)) {
      overlap += 1;
    }
  }
  return overlap;
}

/**
 * Builds a deterministic stack snapshot for recall matching.
 *
 * @param session - Conversation session providing persisted stack/turn state.
 * @returns Canonical conversation stack for recall evaluation.
 */
function resolveConversationStack(session: ConversationSession): ConversationStackV1 {
  return session.conversationStack
    ?? buildConversationStackFromTurnsV1(
      session.conversationTurns,
      session.updatedAt
    );
}

/**
 * Finds the best paused thread candidate for the current user turn.
 *
 * @param stack - Canonical conversation stack to inspect.
 * @param userTokens - Current user-turn topic tokens.
 * @param nowMs - Evaluation timestamp in epoch milliseconds.
 * @returns Highest-scoring paused thread, or `null` when no bounded match exists.
 */
function findBestPausedThreadMatch(
  stack: ConversationStackV1,
  userTokens: readonly string[],
  nowMs: number
): ThreadFrameV1 | null {
  let bestThread: ThreadFrameV1 | null = null;
  let bestScore = -1;

  for (const thread of stack.threads) {
    if (thread.state !== "paused") {
      continue;
    }
    const lastTouchedMs = Date.parse(thread.lastTouchedAt);
    if (!Number.isFinite(lastTouchedMs) || nowMs - lastTouchedMs > MAX_CONTEXTUAL_RECALL_AGE_MS) {
      continue;
    }

    const topicLabelTokens = tokenizeTopicTerms(thread.topicLabel);
    const labelOverlap = countTokenOverlap(userTokens, topicLabelTokens);
    if (labelOverlap < MIN_TOPIC_LABEL_OVERLAP) {
      continue;
    }

    const resumeTokens = tokenizeTopicTerms(thread.resumeHint);
    const resumeOverlap = countTokenOverlap(userTokens, resumeTokens);
    const openLoopCount = thread.openLoops.filter((loop) => loop.status === "open").length;
    const ageBoost = Math.max(0, 1 - ((nowMs - lastTouchedMs) / MAX_CONTEXTUAL_RECALL_AGE_MS));
    const score = (labelOverlap * 3) + resumeOverlap + (openLoopCount * 0.5) + ageBoost;

    if (score > bestScore) {
      bestScore = score;
      bestThread = thread;
    }
  }

  return bestThread;
}

/**
 * Builds a short supporting cue from prior related turns for one paused thread.
 *
 * @param session - Conversation session containing prior turns.
 * @param thread - Matched paused thread.
 * @param userTokens - Current user-turn topic tokens.
 * @returns Best supporting cue text to expose to the model.
 */
function buildSupportingCue(
  session: ConversationSession,
  thread: ThreadFrameV1,
  userTokens: readonly string[]
): string {
  const topicTokens = tokenizeTopicTerms(thread.topicLabel);
  const relatedTurns = session.conversationTurns.filter((turn) => {
    const turnTokens = tokenizeTopicTerms(turn.text);
    return countTokenOverlap(turnTokens, topicTokens) > 0
      || countTokenOverlap(turnTokens, userTokens) > 0;
  });
  const assistantQuestion = [...relatedTurns]
    .reverse()
    .find(
      (turn) =>
        turn.role === "assistant"
        && isLikelyAssistantClarificationPrompt(turn.text)
    );
  const fallbackTurn = [...relatedTurns].reverse()[0] ?? null;
  const rawCue = assistantQuestion?.text ?? fallbackTurn?.text ?? thread.resumeHint;
  const normalizedCue = normalizeWhitespace(rawCue);
  if (normalizedCue.length <= MAX_SUPPORTING_CUE_CHARS) {
    return normalizedCue;
  }
  return `${normalizedCue.slice(0, MAX_SUPPORTING_CUE_CHARS - 3)}...`;
}

/**
 * Suppresses recall when the assistant already asked a very similar follow-up recently.
 *
 * @param session - Conversation session containing recent assistant turns.
 * @param topicLabel - Matched paused-thread topic label.
 * @param userTokens - Current user-turn topic tokens.
 * @returns `true` when a recent assistant turn already covered the recall.
 */
function hasRecentDuplicateAssistantRecall(
  session: ConversationSession,
  topicLabel: string,
  userTokens: readonly string[]
): boolean {
  const topicTokens = tokenizeTopicTerms(topicLabel);
  const assistantTurns = session.conversationTurns
    .filter((turn) => turn.role === "assistant")
    .slice(-RECENT_ASSISTANT_DUPLICATE_LOOKBACK);
  return assistantTurns.some((turn) => {
    if (!isLikelyAssistantClarificationPrompt(turn.text)) {
      return false;
    }
    const turnTokens = tokenizeTopicTerms(turn.text);
    return countTokenOverlap(turnTokens, topicTokens) > 0
      || countTokenOverlap(turnTokens, userTokens) > 0;
  });
}

/**
 * Resolves one bounded in-conversation contextual recall opportunity for the current user turn.
 *
 * @param session - Conversation session providing prior turns and stack state.
 * @param userInput - Current raw user message before execution wrapping.
 * @returns One grounded recall candidate, or `null` when no bounded recall should be offered.
 */
export function resolveContextualRecallCandidate(
  session: ConversationSession,
  userInput: string
): ContextualRecallCandidate | null {
  const normalizedInput = normalizeWhitespace(userInput);
  if (!normalizedInput) {
    return null;
  }

  const userTokens = tokenizeTopicTerms(normalizedInput);
  if (userTokens.length === 0) {
    return null;
  }

  const nowMs = Date.parse(session.updatedAt);
  if (!Number.isFinite(nowMs)) {
    return null;
  }

  const stack = resolveConversationStack(session);
  const matchedThread = findBestPausedThreadMatch(stack, userTokens, nowMs);
  if (!matchedThread) {
    return null;
  }

  if (hasRecentDuplicateAssistantRecall(session, matchedThread.topicLabel, userTokens)) {
    return null;
  }

  const supportingCue = buildSupportingCue(session, matchedThread, userTokens);
  const openLoopCount = matchedThread.openLoops.filter((loop) => loop.status === "open").length;
  return {
    threadKey: matchedThread.threadKey,
    topicLabel: matchedThread.topicLabel,
    supportingCue,
    openLoopCount,
    lastTouchedAt: matchedThread.lastTouchedAt
  };
}

/**
 * Builds the bounded execution-input block for one contextual recall opportunity.
 *
 * @param session - Conversation session providing prior turns and stack state.
 * @param userInput - Current raw user message before execution wrapping.
 * @returns Instruction block appended to execution input, or `null` when no recall applies.
 */
export function buildContextualRecallBlock(
  session: ConversationSession,
  userInput: string
): string | null {
  const candidate = resolveContextualRecallCandidate(session, userInput);
  if (!candidate) {
    return null;
  }

  return [
    "Contextual recall opportunity (optional):",
    `- The user just re-mentioned an older paused topic: ${candidate.topicLabel}`,
    `- Prior thread cue: ${candidate.supportingCue}`,
    `- Open loops on that thread: ${candidate.openLoopCount}`,
    `- Last touched: ${candidate.lastTouchedAt}`,
    "- Response rule: if it fits naturally, you may ask one brief follow-up about that older unresolved thread before continuing.",
    "- Do not force the detour if the current request is clearly unrelated.",
    "- Do not repeat a recent follow-up the assistant already asked."
  ].join("\n");
}
