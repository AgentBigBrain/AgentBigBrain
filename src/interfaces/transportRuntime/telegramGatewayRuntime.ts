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
import {
  buildConversationInboundUserInput
} from "../mediaRuntime/mediaNormalization";
import {
  DEFAULT_TELEGRAM_MEDIA_RUNTIME_CONFIG,
  type TelegramMediaRuntimeConfig,
  validateTelegramMediaAttachments
} from "../mediaRuntime/mediaLimits";
import {
  extractTelegramMediaEnvelope,
  type TelegramDocumentAttachment,
  type TelegramPhotoSize,
  type TelegramVideoAttachment,
  type TelegramVoiceAttachment
} from "../mediaRuntime/telegramMediaIngress";
import type { ConversationDeliveryResult } from "../conversationRuntime/managerContracts";
import type {
  TelegramNotifierOptions,
  TelegramOutboundDeliveryObservation
} from "./contracts";
import {
  createTelegramConversationNotifier,
  editTelegramReply,
  sendTelegramDraftUpdate,
  sendTelegramReply
} from "./telegramTransport";
import { abortAutonomousTransportTaskIfRequested } from "./autonomousAbortControl";
import { shouldNotifyRejectedInvocation } from "./rateLimitPolicy";

export type {
  TelegramDocumentAttachment,
  TelegramPhotoSize,
  TelegramVideoAttachment,
  TelegramVoiceAttachment
} from "../mediaRuntime/telegramMediaIngress";

export interface TelegramUpdateMessage {
  text?: string;
  caption?: string;
  photo?: readonly TelegramPhotoSize[];
  voice?: TelegramVoiceAttachment;
  video?: TelegramVideoAttachment;
  document?: TelegramDocumentAttachment;
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
  mediaConfig?: TelegramInterfaceConfig["media"];
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
 * Normalizes Telegram interface media config into the canonical media-runtime limit shape.
 *
 * @param config - Optional Telegram interface media config.
 * @returns Canonical Telegram media runtime config.
 */
function resolveTelegramMediaRuntimeConfig(
  config: TelegramInterfaceConfig["media"] | undefined
): TelegramMediaRuntimeConfig {
  if (!config) {
    return DEFAULT_TELEGRAM_MEDIA_RUNTIME_CONFIG;
  }
  return {
    enabled: config.enabled,
    maxAttachmentCount: config.maxAttachments,
    maxAttachmentBytes: config.maxAttachmentBytes,
    maxDownloadBytes: config.maxDownloadBytes,
    maxVoiceDurationSeconds: config.maxVoiceSeconds,
    maxVideoDurationSeconds: config.maxVideoSeconds,
    allowImages: config.allowImages,
    allowVoiceNotes: config.allowVoiceNotes,
    allowVideos: config.allowVideos,
    allowDocuments: config.allowDocuments
  };
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
  const media = extractTelegramMediaEnvelope(message);
  const chatId = asTelegramStringId(message?.chat?.id);
  const userId = asTelegramStringId(message?.from?.id);
  const username = message?.from?.username ?? "";
  if (!chatId || !userId || !username) {
    return { kind: "ignored" };
  }

  const mediaValidation = validateTelegramMediaAttachments(
    media?.attachments ?? [],
    resolveTelegramMediaRuntimeConfig(input.mediaConfig)
  );
  if (!mediaValidation.accepted) {
    return {
      kind: "rejected",
      chatId,
      responseText: mediaValidation.message
    };
  }

  const conversationVisibility = resolveTelegramConversationVisibility(message?.chat?.type, chatId, userId);
  const text = (message?.text ?? message?.caption ?? "").trim();
  const mediaOnlyPrivateConversation = !text && Boolean(media) && conversationVisibility === "private";
  const privateConversationBypassesInvocation = conversationVisibility === "private";
  if (!text && !media) {
    return { kind: "ignored" };
  }

  let normalizedText = text;
  if (!mediaOnlyPrivateConversation && privateConversationBypassesInvocation) {
    const invocation = applyInvocationPolicy(text, input.invocationPolicy);
    normalizedText = invocation.accepted ? invocation.normalizedText : text;
  } else if (!mediaOnlyPrivateConversation) {
    const invocation = applyInvocationPolicy(text, input.invocationPolicy);
    if (!invocation.accepted) {
      return { kind: "ignored" };
    }
    normalizedText = invocation.normalizedText;
  } else if (mediaOnlyPrivateConversation) {
    normalizedText = "";
  }

  const receivedAt = new Date((message?.date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString();
  const inbound: TelegramInboundMessage = {
    updateId: input.update.update_id,
    chatId,
    userId,
    username,
    text: normalizedText,
    media,
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
    normalizedText,
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
    conversationVisibility,
    inbound,
    entityGraphEvent: {
      provider: "telegram",
      conversationId: chatId,
      eventId: String(input.update.update_id),
      text: buildConversationInboundUserInput(normalizedText, media),
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
  allocateDraftId: () => number,
  observeOutboundDelivery?: (
    event: TelegramOutboundDeliveryObservation
  ) => void | Promise<void>
) {
  return createTelegramConversationNotifier({
    renderOutboundText: (messageText: string) =>
      applyInvocationHints(messageText, config.security.invocation),
    nativeDraftStreamingEnabled:
      config.streamingTransportMode === "native_draft" &&
      config.nativeDraftStreaming &&
      options.nativeDraftStreamingAllowed,
    allocateDraftId,
    sendReply: async (messageText: string) => {
      const result = await sendTelegramGatewayReply(config, chatId, messageText);
      if (result.ok) {
        await observeOutboundDelivery?.({
          kind: "send",
          chatId,
          text: messageText,
          at: new Date().toISOString(),
          messageId: result.messageId
        });
      }
      return result;
    },
    editReply: async (messageId: string, messageText: string) => {
      const result = await editTelegramGatewayReply(config, chatId, messageId, messageText);
      if (result.ok) {
        await observeOutboundDelivery?.({
          kind: "edit",
          chatId,
          text: messageText,
          at: new Date().toISOString(),
          messageId
        });
      }
      return result;
    },
    sendDraftUpdate: async (draftId: number, messageText: string) => {
      const result = await sendTelegramGatewayDraftUpdate(config, chatId, draftId, messageText);
      if (result.ok) {
        await observeOutboundDelivery?.({
          kind: "draft",
          chatId,
          text: messageText,
          at: new Date().toISOString(),
          draftId,
          messageId: result.messageId
        });
      }
      return result;
    }
  });
}



