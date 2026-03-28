/**
 * @fileoverview Shared contracts for extracted Discord and Telegram transport delivery helpers.
 */

import type {
  ConversationDeliveryResult,
  ConversationOutboundDeliveryTrace,
  ConversationNotifierTransport
} from "../conversationRuntime/managerContracts";

export type TransportFetch = typeof fetch;

export type SleepFn = (ms: number) => Promise<void>;

export interface DiscordChannelMessageInput {
  apiBaseUrl: string;
  botToken: string;
  channelId: string;
  text: string;
  fetchImpl?: TransportFetch;
  sleepImpl?: SleepFn;
  logDebug?(message: string): void;
}

export interface DiscordMessageEditInput {
  apiBaseUrl: string;
  botToken: string;
  channelId: string;
  messageId: string;
  text: string;
  fetchImpl?: TransportFetch;
  sleepImpl?: SleepFn;
}

export interface DiscordNotifierFactoryInput {
  renderOutboundText(text: string): string;
  sendMessage(text: string): Promise<ConversationDeliveryResult>;
  editMessage(messageId: string, text: string): Promise<ConversationDeliveryResult>;
}

export interface TelegramSendReplyInput {
  apiBaseUrl: string;
  botToken: string;
  chatId: string;
  text: string;
  fetchImpl?: TransportFetch;
}

export interface TelegramEditReplyInput {
  apiBaseUrl: string;
  botToken: string;
  chatId: string;
  messageId: string;
  text: string;
  fetchImpl?: TransportFetch;
}

export interface TelegramDraftUpdateInput {
  apiBaseUrl: string;
  botToken: string;
  chatId: string;
  draftId: number;
  text: string;
  fetchImpl?: TransportFetch;
}

export interface TelegramNotifierOptions {
  nativeDraftStreamingAllowed: boolean;
}

export interface TelegramOutboundDeliveryObservation {
  kind: "send" | "edit" | "draft";
  chatId: string;
  text: string;
  at: string;
  sequence: number;
  source: ConversationOutboundDeliveryTrace["source"] | null;
  sessionKey: string | null;
  jobId: string | null;
  jobCreatedAt: string | null;
  inboundEventId: string | null;
  inboundReceivedAt: string | null;
  messageId?: string | null;
  draftId?: number | null;
}

export type TelegramOutboundDeliveryObserver = (
  event: TelegramOutboundDeliveryObservation
) => void | Promise<void>;

export interface TelegramNotifierFactoryInput {
  renderOutboundText(text: string): string;
  nativeDraftStreamingEnabled: boolean;
  allocateDraftId(): number;
  allocateDeliverySequence(): number;
  baseTrace?: Omit<ConversationOutboundDeliveryTrace, "source">;
  sendReply(
    text: string,
    trace?: ConversationOutboundDeliveryTrace
  ): Promise<ConversationDeliveryResult>;
  editReply(
    messageId: string,
    text: string,
    trace?: ConversationOutboundDeliveryTrace
  ): Promise<ConversationDeliveryResult>;
  sendDraftUpdate(
    draftId: number,
    text: string,
    trace?: ConversationOutboundDeliveryTrace
  ): Promise<ConversationDeliveryResult>;
}

export interface TransportNotifierFactories {
  createDiscordConversationNotifier(
    input: DiscordNotifierFactoryInput
  ): ConversationNotifierTransport;
  createTelegramConversationNotifier(
    input: TelegramNotifierFactoryInput
  ): ConversationNotifierTransport;
}
