/**
 * @fileoverview Canonical Telegram media-ingest parsing for images, short videos, voice notes, and documents.
 */

import type {
  ConversationInboundMediaAttachment,
  ConversationInboundMediaEnvelope
} from "./contracts";
import { hasConversationMedia } from "./contracts";

export interface TelegramPhotoSize {
  file_id?: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
  file_size?: number;
}

export interface TelegramVoiceAttachment {
  file_id?: string;
  file_unique_id?: string;
  duration?: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVideoAttachment {
  file_id?: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
  duration?: number;
  mime_type?: string;
  file_size?: number;
  file_name?: string;
}

export interface TelegramDocumentAttachment {
  file_id?: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMediaMessageLike {
  caption?: string;
  photo?: readonly TelegramPhotoSize[];
  voice?: TelegramVoiceAttachment;
  video?: TelegramVideoAttachment;
  document?: TelegramDocumentAttachment;
}

/**
 * Normalizes one Telegram photo payload into the canonical image attachment shape.
 *
 * @param photo - Telegram photo payload.
 * @param caption - Optional Telegram caption applied to the same message.
 * @returns Canonical image attachment, or `null` when the payload is incomplete.
 */
function normalizePhotoAttachment(
  photo: TelegramPhotoSize | undefined,
  caption: string | undefined
): ConversationInboundMediaAttachment | null {
  if (!photo?.file_id) {
    return null;
  }
  return {
    kind: "image",
    provider: "telegram",
    fileId: photo.file_id,
    fileUniqueId: photo.file_unique_id ?? null,
    mimeType: "image/jpeg",
    fileName: null,
    sizeBytes: typeof photo.file_size === "number" ? photo.file_size : null,
    caption: caption?.trim() || null,
    durationSeconds: null,
    width: typeof photo.width === "number" ? photo.width : null,
    height: typeof photo.height === "number" ? photo.height : null
  };
}

/**
 * Normalizes one Telegram voice-note payload into the canonical voice attachment shape.
 *
 * @param voice - Telegram voice-note payload.
 * @param caption - Optional Telegram caption applied to the same message.
 * @returns Canonical voice attachment, or `null` when the payload is incomplete.
 */
function normalizeVoiceAttachment(
  voice: TelegramVoiceAttachment | undefined,
  caption: string | undefined
): ConversationInboundMediaAttachment | null {
  if (!voice?.file_id) {
    return null;
  }
  return {
    kind: "voice",
    provider: "telegram",
    fileId: voice.file_id,
    fileUniqueId: voice.file_unique_id ?? null,
    mimeType: voice.mime_type ?? "audio/ogg",
    fileName: null,
    sizeBytes: typeof voice.file_size === "number" ? voice.file_size : null,
    caption: caption?.trim() || null,
    durationSeconds: typeof voice.duration === "number" ? voice.duration : null,
    width: null,
    height: null
  };
}

/**
 * Normalizes one Telegram video payload into the canonical short-video attachment shape.
 *
 * @param video - Telegram video payload.
 * @param caption - Optional Telegram caption applied to the same message.
 * @returns Canonical video attachment, or `null` when the payload is incomplete.
 */
function normalizeVideoAttachment(
  video: TelegramVideoAttachment | undefined,
  caption: string | undefined
): ConversationInboundMediaAttachment | null {
  if (!video?.file_id) {
    return null;
  }
  return {
    kind: "video",
    provider: "telegram",
    fileId: video.file_id,
    fileUniqueId: video.file_unique_id ?? null,
    mimeType: video.mime_type ?? "video/mp4",
    fileName: video.file_name ?? null,
    sizeBytes: typeof video.file_size === "number" ? video.file_size : null,
    caption: caption?.trim() || null,
    durationSeconds: typeof video.duration === "number" ? video.duration : null,
    width: typeof video.width === "number" ? video.width : null,
    height: typeof video.height === "number" ? video.height : null
  };
}

/**
 * Normalizes one Telegram document payload into the canonical document attachment shape.
 *
 * @param document - Telegram document payload.
 * @param caption - Optional Telegram caption applied to the same message.
 * @returns Canonical document attachment, or `null` when the payload is incomplete.
 */
function normalizeDocumentAttachment(
  document: TelegramDocumentAttachment | undefined,
  caption: string | undefined
): ConversationInboundMediaAttachment | null {
  if (!document?.file_id) {
    return null;
  }
  return {
    kind: "document",
    provider: "telegram",
    fileId: document.file_id,
    fileUniqueId: document.file_unique_id ?? null,
    mimeType: document.mime_type ?? null,
    fileName: document.file_name ?? null,
    sizeBytes: typeof document.file_size === "number" ? document.file_size : null,
    caption: caption?.trim() || null,
    durationSeconds: null,
    width: null,
    height: null
  };
}

/**
 * Extracts a bounded normalized media envelope from one Telegram message payload.
 *
 * @param message - Telegram message payload that may carry photo, voice, video, or document data.
 * @returns Normalized media envelope, or `null` when no supported media is present.
 */
export function extractTelegramMediaEnvelope(
  message: TelegramMediaMessageLike | undefined
): ConversationInboundMediaEnvelope | null {
  if (!message) {
    return null;
  }

  const attachments: ConversationInboundMediaAttachment[] = [];
  const largestPhoto = [...(message.photo ?? [])]
    .filter((photo) => Boolean(photo.file_id))
    .sort((left, right) => (right.file_size ?? 0) - (left.file_size ?? 0))[0];
  const normalizedPhoto = normalizePhotoAttachment(largestPhoto, message.caption);
  if (normalizedPhoto) {
    attachments.push(normalizedPhoto);
  }
  const normalizedVoice = normalizeVoiceAttachment(message.voice, message.caption);
  if (normalizedVoice) {
    attachments.push(normalizedVoice);
  }
  const normalizedVideo = normalizeVideoAttachment(message.video, message.caption);
  if (normalizedVideo) {
    attachments.push(normalizedVideo);
  }
  const normalizedDocument = normalizeDocumentAttachment(message.document, message.caption);
  if (normalizedDocument) {
    attachments.push(normalizedDocument);
  }

  if (attachments.length === 0) {
    return null;
  }
  return { attachments };
}

/**
 * Returns `true` when one Telegram message carries at least one supported media attachment.
 *
 * @param message - Telegram message payload that may carry supported media.
 * @returns `true` when one supported media attachment exists.
 */
export function hasTelegramMedia(message: TelegramMediaMessageLike | undefined): boolean {
  return hasConversationMedia(extractTelegramMediaEnvelope(message));
}
