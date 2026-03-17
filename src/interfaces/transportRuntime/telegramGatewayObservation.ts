/**
 * @fileoverview Shared outbound-delivery observation helpers for Telegram live-smoke instrumentation.
 */

import type { ConversationDeliveryResult } from "../conversationRuntime/managerContracts";
import type { TelegramInterfaceConfig } from "../runtimeConfig";
import type {
  TelegramOutboundDeliveryObservation,
  TelegramOutboundDeliveryObserver
} from "./contracts";
import { sendTelegramGatewayReply } from "./telegramGatewayRuntime";

/**
 * Records one successful Telegram outbound delivery for an optional observer without breaking runtime flow.
 *
 * @param observer - Optional outbound delivery observer.
 * @param event - Canonical outbound delivery observation.
 * @returns Promise resolving after the observer settles.
 */
export async function observeTelegramOutboundDelivery(
  observer: TelegramOutboundDeliveryObserver | undefined,
  event: TelegramOutboundDeliveryObservation
): Promise<void> {
  if (!observer) {
    return;
  }
  try {
    await observer(event);
  } catch (error) {
    console.warn(
      `[TelegramGateway] outbound delivery observer failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

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
  observer?: TelegramOutboundDeliveryObserver
): Promise<ConversationDeliveryResult> {
  const result = await sendTelegramGatewayReply(config, chatId, text);
  if (result.ok) {
    await observeTelegramOutboundDelivery(observer, {
      kind: "send",
      chatId,
      text,
      at: new Date().toISOString(),
      messageId: result.messageId
    });
  }
  return result;
}
