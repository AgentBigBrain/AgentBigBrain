/**
 * @fileoverview Normalizes notifier callbacks into the canonical transport-capable worker contract.
 */

import type { ConversationNotifierTransport } from "../conversationWorkerLifecycle";
import type { ConversationNotifier } from "./managerContracts";

/**
 * Returns `true` when a notifier already implements the transport contract expected by worker
 * runtime helpers.
 *
 * @param notify - Candidate notifier callback/object from the stable conversation manager.
 * @returns `true` when the notifier already exposes transport capabilities and `send(...)`.
 */
export function isConversationNotifierTransport(
  notify: ConversationNotifier
): notify is ConversationNotifierTransport {
  if (!notify || typeof notify !== "object") {
    return false;
  }

  const candidate = notify as Partial<ConversationNotifierTransport>;
  const supportsEdit = candidate.capabilities?.supportsEdit;
  const supportsNativeStreaming = candidate.capabilities?.supportsNativeStreaming;
  return (
    typeof candidate.send === "function" &&
    Boolean(candidate.capabilities) &&
    typeof supportsEdit === "boolean" &&
    typeof supportsNativeStreaming === "boolean"
  );
}

/**
 * Normalizes notifier callbacks into the canonical transport-capable worker contract.
 *
 * @param notify - Notifier callback/object from the stable conversation manager surface.
 * @returns Transport-capable notifier used by queue workers.
 */
export function toConversationNotifierTransport(
  notify: ConversationNotifier
): ConversationNotifierTransport {
  if (isConversationNotifierTransport(notify)) {
    return notify;
  }

  return {
    capabilities: {
      supportsEdit: false,
      supportsNativeStreaming: false
    },
    send: async (message: string) => {
      await notify(message);
      return {
        ok: true,
        messageId: null,
        errorCode: null
      };
    }
  };
}
