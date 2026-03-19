/**
 * @fileoverview Detects explicit conversational-interlude requests that should stay off the work queue.
 */

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
 * Returns `true` when the user explicitly wants a conversational interlude instead of more work.
 *
 * @param value - Raw inbound user text.
 * @returns `true` when the request should stay on the direct-conversation path.
 */
export function isDirectConversationOnlyRequest(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }
  if (DIRECT_CHAT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  return (
    PAUSE_WORK_PATTERNS.some((pattern) => pattern.test(normalized)) &&
    CONVERSATION_REPLY_HINT_PATTERN.test(normalized)
  );
}
