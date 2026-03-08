/**
 * @fileoverview Canonical Discord gateway helpers for inbound parsing and outbound notifier wiring.
 */

import type {
  DiscordAdapterValidationResult,
  DiscordInboundMessage
} from "../discordAdapter";
import { applyInvocationHints } from "../invocationHints";
import { applyInvocationPolicy } from "../invocationPolicy";
import type { DiscordInterfaceConfig } from "../runtimeConfig";
import type { ConversationDeliveryResult } from "../conversationRuntime/managerContracts";
import {
  createDiscordConversationNotifier,
  editDiscordChannelMessage,
  sendDiscordChannelMessage
} from "./discordTransport";
import { abortAutonomousTransportTaskIfRequested } from "./gatewayLifecycle";
import { shouldNotifyRejectedInvocation } from "./rateLimitPolicy";

export interface DiscordAuthor {
  id?: string;
  username?: string;
  bot?: boolean;
}

export interface DiscordMessageCreateData {
  id?: string;
  channel_id?: string;
  guild_id?: string;
  content?: string;
  author?: DiscordAuthor;
  timestamp?: string;
}

export interface DiscordEntityGraphEvent {
  provider: "discord";
  conversationId: string;
  eventId: string;
  text: string;
  observedAt: string;
}

export interface PreparedDiscordAcceptedMessage {
  kind: "accepted";
  messageId: string;
  channelId: string;
  userId: string;
  username: string;
  conversationVisibility: "private" | "public";
  inbound: DiscordInboundMessage;
  entityGraphEvent: DiscordEntityGraphEvent;
}

export interface PreparedDiscordIgnoredMessage {
  kind: "ignored";
}

export interface PreparedDiscordRejectedMessage {
  kind: "rejected";
  channelId: string;
  responseText: string | null;
}

export interface PreparedDiscordStopMessage {
  kind: "stop";
  channelId: string;
  responseText: string;
}

export type PreparedDiscordMessageCreateResult =
  | PreparedDiscordAcceptedMessage
  | PreparedDiscordIgnoredMessage
  | PreparedDiscordRejectedMessage
  | PreparedDiscordStopMessage;

export interface PrepareDiscordMessageCreateInput {
  data: DiscordMessageCreateData;
  botUserId: string;
  sharedSecret: string;
  invocationPolicy: DiscordInterfaceConfig["security"]["invocation"];
  validateMessage(message: DiscordInboundMessage): DiscordAdapterValidationResult;
  abortControllers: Map<string, AbortController>;
}

/**
 * Resolves conversation visibility for Discord payloads.
 *
 * @param guildId - Optional guild identifier from the inbound event.
 * @returns Public/private visibility derived from the payload.
 */
export function resolveDiscordConversationVisibility(
  guildId: string | undefined
): "private" | "public" {
  return guildId ? "public" : "private";
}

/**
 * Parses and validates a Discord MESSAGE_CREATE payload before conversation execution.
 *
 * @param input - Provider-specific parse/validation dependencies.
 * @returns Deterministic parse result for the gateway coordinator.
 */
export function prepareDiscordMessageCreate(
  input: PrepareDiscordMessageCreateInput
): PreparedDiscordMessageCreateResult {
  const messageId = input.data.id ?? "";
  const channelId = input.data.channel_id ?? "";
  const text = input.data.content ?? "";
  const userId = input.data.author?.id ?? "";
  const username = input.data.author?.username ?? "";
  const isBotAuthor = input.data.author?.bot === true;
  if (!messageId || !channelId || !text.trim() || !userId || !username) {
    return { kind: "ignored" };
  }
  if (isBotAuthor || (input.botUserId && userId === input.botUserId)) {
    return { kind: "ignored" };
  }

  const invocation = applyInvocationPolicy(text, input.invocationPolicy);
  if (!invocation.accepted) {
    return { kind: "ignored" };
  }

  const receivedAt = input.data.timestamp ?? new Date().toISOString();
  const inbound: DiscordInboundMessage = {
    messageId,
    channelId,
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
      channelId,
      responseText: shouldNotifyRejectedInvocation(validation.code) ? validation.message : null
    };
  }

  const stopRequested = abortAutonomousTransportTaskIfRequested(
    channelId,
    invocation.normalizedText,
    input.abortControllers
  );
  if (stopRequested) {
    return {
      kind: "stop",
      channelId,
      responseText: "Autonomous loop cancelled."
    };
  }

  return {
    kind: "accepted",
    messageId,
    channelId,
    userId,
    username,
    conversationVisibility: resolveDiscordConversationVisibility(input.data.guild_id),
    inbound,
    entityGraphEvent: {
      provider: "discord",
      conversationId: channelId,
      eventId: messageId,
      text: invocation.normalizedText,
      observedAt: receivedAt
    }
  };
}

/**
 * Sends a user-facing Discord reply using gateway config and invocation-hint rendering.
 *
 * @param config - Active Discord interface configuration.
 * @param channelId - Destination channel identifier.
 * @param text - User-facing text to send.
 * @param logDebug - Optional debug logger used by Discord transport.
 * @returns Delivery result from the transport helper.
 */
export async function sendDiscordGatewayMessage(
  config: DiscordInterfaceConfig,
  channelId: string,
  text: string,
  logDebug?: (message: string) => void
): Promise<ConversationDeliveryResult> {
  return sendDiscordChannelMessage({
    apiBaseUrl: config.apiBaseUrl,
    botToken: config.botToken,
    channelId,
    text: applyInvocationHints(text, config.security.invocation),
    logDebug
  });
}

/**
 * Edits a previously sent Discord reply using gateway config and invocation-hint rendering.
 *
 * @param config - Active Discord interface configuration.
 * @param channelId - Destination channel identifier.
 * @param messageId - Existing Discord message identifier.
 * @param text - Updated user-facing text.
 * @returns Delivery result from the transport helper.
 */
export async function editDiscordGatewayMessage(
  config: DiscordInterfaceConfig,
  channelId: string,
  messageId: string,
  text: string
): Promise<ConversationDeliveryResult> {
  return editDiscordChannelMessage({
    apiBaseUrl: config.apiBaseUrl,
    botToken: config.botToken,
    channelId,
    messageId,
    text: applyInvocationHints(text, config.security.invocation)
  });
}

/**
 * Creates a Discord conversation notifier bound to one channel using canonical gateway wrappers.
 *
 * @param config - Active Discord interface configuration.
 * @param channelId - Destination channel identifier.
 * @param logDebug - Optional debug logger used by Discord transport.
 * @returns Conversation notifier bound to the supplied channel.
 */
export function createDiscordGatewayNotifier(
  config: DiscordInterfaceConfig,
  channelId: string,
  logDebug?: (message: string) => void
) {
  return createDiscordConversationNotifier({
    renderOutboundText: (messageText: string) =>
      applyInvocationHints(messageText, config.security.invocation),
    sendMessage: (messageText: string) =>
      sendDiscordGatewayMessage(config, channelId, messageText, logDebug),
    editMessage: (messageId: string, messageText: string) =>
      editDiscordGatewayMessage(config, channelId, messageId, messageText)
  });
}
