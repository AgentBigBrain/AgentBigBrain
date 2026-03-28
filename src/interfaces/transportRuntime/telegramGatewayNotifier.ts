/**
 * @fileoverview Canonical Telegram gateway notifier and send/edit wrapper helpers.
 */

import { applyInvocationHints } from "../invocationHints";
import type { ConversationDeliveryResult } from "../conversationRuntime/managerContracts";
import type { TelegramInterfaceConfig } from "../runtimeConfig";
import type { TelegramNotifierOptions, TelegramOutboundDeliveryObservation } from "./contracts";
import {
  createTelegramConversationNotifier,
  editTelegramReply,
  sendTelegramDraftUpdate,
  sendTelegramReply
} from "./telegramTransport";
import { mergeTelegramOutboundDeliveryTrace, observeTelegramOutboundDeliverySafely } from "./telegramOutboundDeliveryTracing";

/**
 * Sends a user-facing Telegram reply using gateway config and invocation-hint rendering.
 *
 * @param config - Active Telegram interface configuration.
 * @param chatId - Destination chat identifier.
 * @param text - User-facing text to send.
 * @returns Delivery result from the transport helper.
 */
export async function sendTelegramGatewayReply(
  config: TelegramInterfaceConfig,
  chatId: string,
  text: string
): Promise<ConversationDeliveryResult> {
  return sendTelegramReply({
    apiBaseUrl: config.apiBaseUrl,
    botToken: config.botToken,
    chatId,
    text: applyInvocationHints(text, config.security.invocation)
  });
}

/**
 * Edits a previously sent Telegram reply using gateway config and invocation-hint rendering.
 *
 * @param config - Active Telegram interface configuration.
 * @param chatId - Destination chat identifier.
 * @param messageId - Existing Telegram message identifier.
 * @param text - Updated user-facing text.
 * @returns Delivery result from the transport helper.
 */
export async function editTelegramGatewayReply(
  config: TelegramInterfaceConfig,
  chatId: string,
  messageId: string,
  text: string
): Promise<ConversationDeliveryResult> {
  return editTelegramReply({
    apiBaseUrl: config.apiBaseUrl,
    botToken: config.botToken,
    chatId,
    messageId,
    text: applyInvocationHints(text, config.security.invocation)
  });
}

/**
 * Sends a Telegram native draft update using gateway config and invocation-hint rendering.
 *
 * @param config - Active Telegram interface configuration.
 * @param chatId - Destination chat identifier.
 * @param draftId - Stable draft identifier for the stream.
 * @param text - Draft update text.
 * @returns Delivery result from the transport helper.
 */
export async function sendTelegramGatewayDraftUpdate(
  config: TelegramInterfaceConfig,
  chatId: string,
  draftId: number,
  text: string
): Promise<ConversationDeliveryResult> {
  return sendTelegramDraftUpdate({
    apiBaseUrl: config.apiBaseUrl,
    botToken: config.botToken,
    chatId,
    draftId,
    text: applyInvocationHints(text, config.security.invocation)
  });
}

/**
 * Allocates the next Telegram draft identifier with wraparound.
 *
 * @param currentDraftId - Current in-memory draft counter.
 * @returns Allocated draft id and next counter value.
 */
export function allocateNextTelegramDraftId(
  currentDraftId: number
): { draftId: number; nextDraftId: number } {
  const draftId = currentDraftId;
  return { draftId, nextDraftId: currentDraftId + 1 > 2_147_483_647 ? 1 : currentDraftId + 1 };
}

/**
 * Creates a Telegram conversation notifier bound to one chat using canonical gateway wrappers.
 *
 * @param config - Active Telegram interface configuration.
 * @param chatId - Destination chat identifier.
 * @param options - Per-notifier capability options.
 * @param allocateDraftId - Draft id allocator supplied by the gateway state holder.
 * @returns Conversation notifier bound to the supplied chat.
 */
export function createTelegramGatewayNotifier(
  config: TelegramInterfaceConfig,
  chatId: string,
  options: TelegramNotifierOptions,
  allocateDraftId: () => number,
  allocateDeliverySequence: () => number,
  baseTrace?: {
    sessionKey?: string | null;
    inboundEventId?: string | null;
    inboundReceivedAt?: string | null;
  },
  observeOutboundDelivery?: (
    event: TelegramOutboundDeliveryObservation
  ) => void | Promise<void>
) {
  const observeTelegramDelivery = async (
    kind: TelegramOutboundDeliveryObservation["kind"],
    messageText: string,
    sequence: number,
    trace?: Parameters<typeof mergeTelegramOutboundDeliveryTrace>[2],
    extras?: {
      messageId?: string | null;
      draftId?: number | null;
    }
  ): Promise<void> => {
    await observeTelegramOutboundDeliverySafely(observeOutboundDelivery, {
      kind,
      chatId,
      text: messageText,
      at: new Date().toISOString(),
      ...mergeTelegramOutboundDeliveryTrace(sequence, baseTrace, trace),
      messageId: extras?.messageId,
      draftId: extras?.draftId
    });
  };

  return createTelegramConversationNotifier({
    renderOutboundText: (messageText: string) =>
      applyInvocationHints(messageText, config.security.invocation),
    nativeDraftStreamingEnabled:
      config.streamingTransportMode === "native_draft" &&
      config.nativeDraftStreaming &&
      options.nativeDraftStreamingAllowed,
    allocateDraftId,
    allocateDeliverySequence,
    baseTrace,
    sendReply: async (messageText: string, trace) => {
      const result = await sendTelegramGatewayReply(config, chatId, messageText);
      if (result.ok) {
        await observeTelegramDelivery(
          "send",
          messageText,
          allocateDeliverySequence(),
          trace,
          { messageId: result.messageId }
        );
      }
      return result;
    },
    editReply: async (messageId: string, messageText: string, trace) => {
      const result = await editTelegramGatewayReply(config, chatId, messageId, messageText);
      if (result.ok) {
        await observeTelegramDelivery(
          "edit",
          messageText,
          allocateDeliverySequence(),
          trace,
          { messageId }
        );
      }
      return result;
    },
    sendDraftUpdate: async (draftId: number, messageText: string, trace) => {
      const result = await sendTelegramGatewayDraftUpdate(config, chatId, draftId, messageText);
      if (result.ok) {
        await observeTelegramDelivery(
          "draft",
          messageText,
          allocateDeliverySequence(),
          trace,
          {
            draftId,
            messageId: result.messageId
          }
        );
      }
      return result;
    }
  });
}
