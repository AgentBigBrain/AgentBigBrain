/**
 * @fileoverview Detects explicit conversational-interlude requests that should stay off the work queue.
 */

import {
  collectConversationChatTurnRawTokens,
  normalizeConversationChatTurnWhitespace
} from "./chatTurnSignalAnalysis";

const DIRECT_CHAT_PATTERNS: readonly RegExp[] = [
  /\bjust\s+(?:talk|chat)(?:\s+with\s+me)?\b/i,
  /\b(?:talk|chat)\s+with\s+me(?:\s+for\s+(?:a|one)\s+minute)?\b/i,
  /\bkeep\s+this\s+as\s+(?:conversation|chat)\b/i
] as const;

const PAUSE_WORK_PATTERNS: readonly RegExp[] = [
  /\bbefore\s+changing\s+anything\b/i,
  /\bwithout\s+changing\s+anything\b/i,
  /\bdo\s+not\s+(?:start|continue)\s+(?:work|the workflow|the build)\b/i
] as const;

const CONVERSATION_REPLY_HINT_PATTERN =
  /\b(?:talk|chat|reply|paragraphs?)\b/i;

/**
 * Returns whether one bounded token sequence appears contiguously inside the normalized raw token list.
 *
 * @param rawTokens - Normalized raw tokens for the current turn.
 * @param sequence - Candidate token sequence that must appear contiguously.
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
 * Returns whether the turn explicitly asks for conversation before a possible later action.
 *
 * @param rawTokens - Normalized raw tokens for the current turn.
 * @returns `true` when the user is clearly asking to talk first instead of executing immediately.
 */
function hasBeforeActionConversationPauseShape(rawTokens: readonly string[]): boolean {
  if (rawTokens.length === 0 || rawTokens.length > 24) {
    return false;
  }
  const hasConversationCue =
    rawTokens.includes("talk") ||
    rawTokens.includes("chat") ||
    rawTokens.includes("reply") ||
    rawTokens.includes("paragraph") ||
    rawTokens.includes("paragraphs");
  if (!hasConversationCue) {
    return false;
  }
  return (
    hasTokenSequence(rawTokens, ["before", "you"]) ||
    hasTokenSequence(rawTokens, ["before", "we"]) ||
    hasTokenSequence(rawTokens, ["before", "changing", "anything"]) ||
    hasTokenSequence(rawTokens, ["without", "changing", "anything"])
  );
}

/**
 * Returns `true` when the user explicitly wants a conversational interlude instead of more work.
 *
 * @param value - Raw inbound user text.
 * @returns `true` when the request should stay on the direct-conversation path.
 */
export function isDirectConversationOnlyRequest(value: string): boolean {
  const normalized = normalizeConversationChatTurnWhitespace(value);
  if (!normalized) {
    return false;
  }
  if (DIRECT_CHAT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  const rawTokens = collectConversationChatTurnRawTokens(normalized);
  if (hasBeforeActionConversationPauseShape(rawTokens)) {
    return true;
  }
  return (
    PAUSE_WORK_PATTERNS.some((pattern) => pattern.test(normalized)) &&
    CONVERSATION_REPLY_HINT_PATTERN.test(normalized)
  );
}
