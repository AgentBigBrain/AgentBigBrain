/**
 * @fileoverview Owns deterministic autonomous-stop intent and abort-controller helpers for transport runtimes.
 */

/**
 * Returns `true` when user input is an explicit autonomous stop or cancel request.
 *
 * @param text - User input text.
 * @returns `true` when the text should abort an active autonomous loop.
 */
export function isAutonomousStopIntent(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized === "/stop" ||
    normalized === "stop" ||
    normalized === "stop!" ||
    normalized === "/cancel" ||
    normalized.startsWith("/stop ") ||
    normalized.startsWith("stop ")
  );
}

/**
 * Builds the active-run controller key for one transport principal in one provider conversation.
 *
 * @param input - Provider, conversation/chat/channel id, and sender id.
 * @returns User-scoped key used by autonomous abort-controller registries.
 */
export function buildAutonomousAbortControllerKey(input: {
  provider: "telegram" | "discord";
  conversationId: string;
  userId: string;
}): string {
  return `${input.provider}:${input.conversationId}:${input.userId}`;
}

/**
 * Aborts an active autonomous transport task for one provider conversation/principal key.
 *
 * @param controllerKey - Provider/conversation/principal key used to track active controllers.
 * @param abortControllers - Active autonomous abort-controller registry owned by a gateway.
 * @returns `true` when an active autonomous task was aborted.
 */
export function abortAutonomousTransportTask(
  controllerKey: string,
  abortControllers: Map<string, AbortController>
): boolean {
  const controller = abortControllers.get(controllerKey);
  if (!controller) {
    return false;
  }

  controller.abort();
  abortControllers.delete(controllerKey);
  return true;
}

/**
 * Aborts an active autonomous transport task when the current message is an explicit stop intent.
 *
 * @param controllerKey - Provider/conversation/principal key used to track active controllers.
 * @param text - Incoming user text to inspect for stop or cancel intent.
 * @param abortControllers - Active autonomous abort-controller registry owned by a gateway.
 * @returns `true` when an active autonomous task was aborted.
 */
export function abortAutonomousTransportTaskIfRequested(
  controllerKey: string,
  text: string,
  abortControllers: Map<string, AbortController>
): boolean {
  if (!isAutonomousStopIntent(text)) {
    return false;
  }

  return abortAutonomousTransportTask(controllerKey, abortControllers);
}
