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
import type { ConversationInboundMediaEnvelope } from "../mediaRuntime/contracts";

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
 * Returns whether a Telegram media-only turn is an unsupported voice note with no usable
 * transcript, so the transport should fail closed instead of inventing semantic user input.
 *
 * @param canonicalText - Current canonical text assembled before media enrichment.
 * @param media - Interpreted media envelope for the accepted Telegram update.
 * @returns `true` when the turn is a voice-only fallback with no transcript and no explicit text.
 */
function isUntranscribedMediaOnlyVoiceNote(
  canonicalText: string,
  media: ConversationInboundMediaEnvelope | null
): boolean {
  if (canonicalText.trim().length > 0) {
    return false;
  }
  if (!media || media.attachments.length !== 1) {
    return false;
  }
  const [attachment] = media.attachments;
  if (attachment?.kind !== "voice") {
    return false;
  }
  const interpretation = attachment.interpretation;
  if (!interpretation || interpretation.transcript?.trim()) {
    return false;
  }
  return (
    interpretation.source === "metadata_fallback" ||
    interpretation.source === "unavailable"
  );
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

  if (
    isUntranscribedMediaOnlyVoiceNote(
      input.prepared.inbound.text,
      interpretedMedia
    )
  ) {
    return {
      kind: "rejected",
      chatId: input.prepared.chatId,
      responseText:
        "I received your voice note, but I couldn't transcribe it in this environment. Please resend it as text or try again where voice transcription is available."
    };
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
