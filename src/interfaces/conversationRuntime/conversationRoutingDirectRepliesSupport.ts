/**
 * @fileoverview Shared formatting helpers for ordinary direct-conversation replies.
 */

const DIRECT_CONVERSATION_FORMAT_PATTERN = /\btwo short paragraphs\b/i;
const DIRECT_CONVERSATION_PAUSE_WORK_PATTERN =
  /\b(?:just chat|talk for a minute|do not start work|do not continue(?: the)?(?: [a-z-]+)? workflow|keep this as conversation|without doing new work)\b/i;

/**
 * Adds direct-chat-only control lines to the model input when the user asked for them.
 *
 * @param userInput - Raw user wording.
 * @param conversationAwareInput - Existing bounded direct-chat model input.
 * @returns Direct-chat input with any required control lines prepended.
 */
export function buildDirectConversationReplyInput(
  userInput: string,
  conversationAwareInput: string
): string {
  const controlLines: string[] = [];
  if (DIRECT_CONVERSATION_FORMAT_PATTERN.test(userInput)) {
    controlLines.push(
      "Direct reply format requirement: reply in exactly two short paragraphs separated by one blank line."
    );
  }
  if (DIRECT_CONVERSATION_PAUSE_WORK_PATTERN.test(userInput)) {
    controlLines.push(
      "Direct reply intent: answer this as conversation only. Do not continue, summarize, or paraphrase the latest workflow output unless the user explicitly asks for that."
    );
  }
  if (controlLines.length === 0) {
    return conversationAwareInput;
  }
  return `${controlLines.join("\n")}\n\n${conversationAwareInput}`;
}

/**
 * Normalizes direct-chat replies to the requested paragraph format when needed.
 *
 * @param userInput - Raw user wording.
 * @param reply - Model-authored direct reply.
 * @returns Normalized user-facing direct reply text.
 */
export function enforceDirectConversationReplyFormat(
  userInput: string,
  reply: string
): string {
  const normalizedReply = reply.trim();
  if (
    !DIRECT_CONVERSATION_FORMAT_PATTERN.test(userInput) ||
    /\n\s*\n/.test(normalizedReply)
  ) {
    return normalizedReply;
  }
  const sentences = normalizedReply
    .match(/[^.!?]+(?:[.!?]+|$)/g)
    ?.map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0) ?? [];
  if (sentences.length < 2) {
    return normalizedReply;
  }
  const targetLength = normalizedReply.length / 2;
  let bestSplitIndex = 1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let currentLength = 0;
  for (let index = 0; index < sentences.length - 1; index += 1) {
    currentLength += sentences[index].length + 1;
    const distance = Math.abs(currentLength - targetLength);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestSplitIndex = index + 1;
    }
  }
  return [
    sentences.slice(0, bestSplitIndex).join(" "),
    sentences.slice(bestSplitIndex).join(" ")
  ].join("\n\n");
}
