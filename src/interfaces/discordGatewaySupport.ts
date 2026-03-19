/**
 * @fileoverview Small Discord gateway helpers extracted to keep the stable entrypoint thin.
 */

/**
 * Evaluates whether interface debug logging is enabled for the current process.
 *
 * @returns `true` when verbose Discord gateway debug logging should be emitted.
 */
export function isInterfaceDebugEnabled(): boolean {
  return (process.env.BRAIN_INTERFACE_DEBUG ?? "").trim().toLowerCase() === "true";
}

/**
 * Extracts the Discord channel id from a canonical conversation key when possible.
 *
 * @param conversationKey - Canonical conversation key stored in session state.
 * @returns Discord channel id or `null` when the key is not a Discord conversation key.
 */
export function extractChannelIdFromConversationKey(conversationKey: string): string | null {
  const segments = conversationKey.split(":");
  if (segments.length < 3 || segments[0] !== "discord") {
    return null;
  }
  return segments[1] || null;
}
