/**
 * @fileoverview Shared outbound-delivery observation helpers for Telegram live-smoke instrumentation.
 */

import type { ConversationDeliveryResult } from "../conversationRuntime/managerContracts";
import type { TelegramInterfaceConfig } from "../runtimeConfig";
import type {
  TelegramOutboundDeliveryObservation,
  TelegramOutboundDeliveryObserver
} from "./contracts";
import { sendTelegramGatewayReply } from "./telegramGatewayNotifier";
import { observeTelegramOutboundDeliverySafely } from "./telegramOutboundDeliveryTracing";

/**
 * Sends one direct/final Telegram reply and records the delivered text for optional observers.
 *
 * @param config - Active Telegram interface configuration.
 * @param chatId - Target Telegram chat identifier.
 * @param text - User-facing reply text.
 * @param observer - Optional outbound delivery observer.
 * @returns Delivery result from the Telegram transport helper.
 */
export async function sendObservedTelegramGatewayReply(
  config: TelegramInterfaceConfig,
  chatId: string,
  text: string,
  observer?: TelegramOutboundDeliveryObserver,
  observation?: Partial<
    Omit<TelegramOutboundDeliveryObservation, "kind" | "chatId" | "text" | "at" | "messageId" | "draftId">
  >
): Promise<ConversationDeliveryResult> {
  const result = await sendTelegramGatewayReply(config, chatId, text);
  if (result.ok) {
    await observeTelegramOutboundDeliverySafely(observer, {
      kind: "send",
      chatId,
      text,
      at: new Date().toISOString(),
      sequence: observation?.sequence ?? 0,
      source: observation?.source ?? null,
      sessionKey: observation?.sessionKey ?? null,
      jobId: observation?.jobId ?? null,
      jobCreatedAt: observation?.jobCreatedAt ?? null,
      inboundEventId: observation?.inboundEventId ?? null,
      inboundReceivedAt: observation?.inboundReceivedAt ?? null,
      messageId: result.messageId
    });
  }
  return result;
}
