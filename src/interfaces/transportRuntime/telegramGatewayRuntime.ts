/**
 * @fileoverview Canonical Telegram gateway helpers for inbound parsing and outbound notifier wiring.
 */

import type {
  TelegramAdapterValidationResult,
  TelegramInboundMessage
} from "../telegramAdapter";
import { applyInvocationHints } from "../invocationHints";
import { applyInvocationPolicy } from "../invocationPolicy";
import type { TelegramInterfaceConfig } from "../runtimeConfig";
import type { ConversationDeliveryResult } from "../conversationRuntime/managerContracts";
import type { TelegramNotifierOptions } from "./contracts";
import {
  createTelegramConversationNotifier,
  editTelegramReply,
  sendTelegramDraftUpdate,
  sendTelegramReply
} from "./telegramTransport";
import { abortAutonomousTransportTaskIfRequested } from "./gatewayLifecycle";
import { shouldNotifyRejectedInvocation } from "./rateLimitPolicy";

export interface TelegramUpdateMessage {
  text?: string;
  chat?: { id?: number | string; type?: string };
  from?: { id?: number | string; username?: string };
  date?: number;
}

export interface TelegramUpdate {
  update_id?: number;
  message?: TelegramUpdateMessage;
}

export interface TelegramEntityGraphEvent {
  provider: "telegram";
  conversationId: string;
  eventId: string;
  text: string;
  observedAt: string;
}

export interface PreparedTelegramAcceptedUpdate {
  kind: "accepted";
  chatId: string;
  userId: string;
  username: string;
  conversationVisibility: "private" | "public" | "unknown";
  inbound: TelegramInboundMessage;
  entityGraphEvent: TelegramEntityGraphEvent;
}

export interface PreparedTelegramIgnoredUpdate {
  kind: "ignored";
}

export interface PreparedTelegramRejectedUpdate {
  kind: "rejected";
  chatId: string;
  responseText: string | null;
}

export interface PreparedTelegramStopUpdate {
  kind: "stop";
  chatId: string;
  responseText: string;
}

export type PreparedTelegramUpdateResult =
  | PreparedTelegramAcceptedUpdate
  | PreparedTelegramIgnoredUpdate
  | PreparedTelegramRejectedUpdate
  | PreparedTelegramStopUpdate;

export interface PrepareTelegramUpdateInput {
  update: TelegramUpdate;
  sharedSecret: string;
  invocationPolicy: TelegramInterfaceConfig["security"]["invocation"];
  validateMessage(message: TelegramInboundMessage): TelegramAdapterValidationResult;
  abortControllers: Map<string, AbortController>;
}

/**
 * Converts Telegram numeric/string ids into stable string form.
 *
 * @param value - Raw Telegram id field.
 * @returns String id used by downstream runtime helpers.
 */
export function asTelegramStringId(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string") {
    return value;
  }
  return "";
}

/**
 * Resolves Telegram conversation visibility from chat metadata.
 *
 * @param chatType - Telegram chat type.
 * @param chatId - Telegram chat identifier.
 * @param userId - Telegram user identifier.
 * @returns Visibility used by conversation/runtime helpers.
 */
export function resolveTelegramConversationVisibility(
  chatType: string | undefined,
  chatId: string,
  userId: string
): "private" | "public" | "unknown" {
  const normalizedType = (chatType ?? "").trim().toLowerCase();
  if (normalizedType === "private") {
    return "private";
  }
  if (normalizedType === "group" || normalizedType === "supergroup" || normalizedType === "channel") {
    return "public";
  }
  if (chatId === userId) {
    return "private";
  }
  return "unknown";
}

/**
 * Parses and validates a Telegram update before conversation execution.
 *
 * @param input - Provider-specific parse/validation dependencies.
 * @returns Deterministic parse result for the gateway coordinator.
 */
export function prepareTelegramUpdate(
  input: PrepareTelegramUpdateInput
): PreparedTelegramUpdateResult {
  if (typeof input.update.update_id !== "number") {
    return { kind: "ignored" };
  }

  const message = input.update.message;
  const text = message?.text ?? "";
  const chatId = asTelegramStringId(message?.chat?.id);
  const userId = asTelegramStringId(message?.from?.id);
  const username = message?.from?.username ?? "";
  if (!text.trim() || !chatId || !userId || !username) {
    return { kind: "ignored" };
  }

  const invocation = applyInvocationPolicy(text, input.invocationPolicy);
  if (!invocation.accepted) {
    return { kind: "ignored" };
  }

  const receivedAt = new Date((message?.date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString();
  const inbound: TelegramInboundMessage = {
    updateId: input.update.update_id,
    chatId,
    userId,
    username,
    text: invocation.normalizedText,
    authToken: input.sharedSecret,
    receivedAt
  };
  const validation = input.validateMessage(inbound);
  if (!validation.accepted) {
    return {
      kind: "rejected",
      chatId,
      responseText: shouldNotifyRejectedInvocation(validation.code) ? validation.message : null
    };
  }

  const stopRequested = abortAutonomousTransportTaskIfRequested(
    chatId,
    invocation.normalizedText,
    input.abortControllers
  );
  if (stopRequested) {
    return {
      kind: "stop",
      chatId,
      responseText: "Autonomous loop cancelled."
    };
  }

  return {
    kind: "accepted",
    chatId,
    userId,
    username,
    conversationVisibility: resolveTelegramConversationVisibility(message?.chat?.type, chatId, userId),
    inbound,
    entityGraphEvent: {
      provider: "telegram",
      conversationId: chatId,
      eventId: String(input.update.update_id),
      text: invocation.normalizedText,
      observedAt: receivedAt
    }
  };
}

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
  const nextDraftId = currentDraftId + 1 > 2_147_483_647 ? 1 : currentDraftId + 1;
  return { draftId, nextDraftId };
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
  allocateDraftId: () => number
) {
  return createTelegramConversationNotifier({
    renderOutboundText: (messageText: string) =>
      applyInvocationHints(messageText, config.security.invocation),
    nativeDraftStreamingEnabled:
      config.streamingTransportMode === "native_draft" &&
      config.nativeDraftStreaming &&
      options.nativeDraftStreamingAllowed,
    allocateDraftId,
    sendReply: (messageText: string) => sendTelegramGatewayReply(config, chatId, messageText),
    editReply: (messageId: string, messageText: string) =>
      editTelegramGatewayReply(config, chatId, messageId, messageText),
    sendDraftUpdate: (draftId: number, messageText: string) =>
      sendTelegramGatewayDraftUpdate(config, chatId, draftId, messageText)
  });
}
