/**
 * @fileoverview Shared Telegram gateway helpers for media enrichment and chat-id derivation before conversation dispatch.
 */

import { buildConversationInboundUserInput } from "../mediaRuntime/mediaNormalization";
import {
  downloadTelegramFileBuffer,
  resolveTelegramFileDescriptor
} from "../mediaRuntime/telegramFileDownload";
import type { TelegramInterfaceConfig } from "../runtimeConfig";
import type {
  PreparedTelegramAcceptedUpdate,
  PreparedTelegramRejectedUpdate
} from "./telegramGatewayRuntime";
import type { MediaUnderstandingOrgan } from "../../organs/mediaUnderstanding/mediaInterpretation";

/**
 * Derives one Telegram chat id from a canonical conversation key.
 *
 * @param conversationKey - Canonical conversation key emitted by interface runtime state.
 * @returns Telegram chat id, or `null` when the key does not represent one Telegram chat.
 */
export function extractTelegramChatIdFromConversationKey(
  conversationKey: string
): string | null {
  const segments = conversationKey.split(":");
  if (segments.length < 3 || segments[0] !== "telegram") {
    return null;
  }
  return segments[1] || null;
}

export interface EnrichAcceptedTelegramUpdateWithMediaInput {
  prepared: PreparedTelegramAcceptedUpdate;
  config: TelegramInterfaceConfig;
  mediaUnderstandingOrgan?: MediaUnderstandingOrgan;
}

/**
 * Downloads and interprets accepted Telegram media before it enters the shared conversation path.
 *
 * @param input - Accepted Telegram update plus media/runtime dependencies.
 * @returns Accepted update with interpreted media folded into canonical input, or one rejection
 *   when media cannot be safely read.
 */
export async function enrichAcceptedTelegramUpdateWithMedia(
  input: EnrichAcceptedTelegramUpdateWithMediaInput
): Promise<PreparedTelegramAcceptedUpdate | PreparedTelegramRejectedUpdate> {
  const originalMedia = input.prepared.inbound.media ?? null;
  if (!originalMedia) {
    return input.prepared;
  }

  let interpretedMedia = originalMedia;
  if (input.mediaUnderstandingOrgan) {
    try {
      const buffersByFileId = new Map<string, Buffer>();
      for (const attachment of originalMedia.attachments) {
        const descriptor = await resolveTelegramFileDescriptor(
          input.config.apiBaseUrl,
          input.config.botToken,
          attachment.fileId
        );
        const buffer = await downloadTelegramFileBuffer(
          descriptor,
          input.config.media.maxDownloadBytes
        );
        buffersByFileId.set(attachment.fileId, buffer);
      }
      interpretedMedia =
        (await input.mediaUnderstandingOrgan.interpretEnvelope(
          originalMedia,
          buffersByFileId
        )) ?? originalMedia;
    } catch (error) {
      console.warn(
        `[TelegramGateway] media ingest rejected: ${(error as Error).message}`
      );
      return {
        kind: "rejected",
        chatId: input.prepared.chatId,
        responseText:
          "I couldn't safely read that media attachment. Please resend it or describe it in text."
      };
    }
  }

  const canonicalUserInput = buildConversationInboundUserInput(
    input.prepared.inbound.text,
    interpretedMedia
  );
  return {
    ...input.prepared,
    inbound: {
      ...input.prepared.inbound,
      text: canonicalUserInput,
      media: interpretedMedia
    },
    entityGraphEvent: {
      ...input.prepared.entityGraphEvent,
      text: canonicalUserInput
    }
  };
}
