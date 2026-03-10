/**
 * @fileoverview Canonical Telegram media-ingest limits and fail-closed validation helpers.
 */

import type { ConversationInboundMediaAttachment } from "./contracts";

export interface TelegramMediaRuntimeConfig {
  enabled: boolean;
  maxAttachmentCount: number;
  maxAttachmentBytes: number;
  maxDownloadBytes: number;
  maxVoiceDurationSeconds: number;
  maxVideoDurationSeconds: number;
  allowImages: boolean;
  allowVoiceNotes: boolean;
  allowVideos: boolean;
  allowDocuments: boolean;
}

export interface MediaValidationDecision {
  accepted: boolean;
  message: string | null;
}

export const DEFAULT_TELEGRAM_MEDIA_RUNTIME_CONFIG: TelegramMediaRuntimeConfig = {
  enabled: true,
  maxAttachmentCount: 3,
  maxAttachmentBytes: 20 * 1024 * 1024,
  maxDownloadBytes: 20 * 1024 * 1024,
  maxVoiceDurationSeconds: 300,
  maxVideoDurationSeconds: 180,
  allowImages: true,
  allowVoiceNotes: true,
  allowVideos: true,
  allowDocuments: true
};

/**
 * Applies deterministic media limits to one normalized Telegram media envelope.
 *
 * @param attachments - Normalized media attachments extracted from one update.
 * @param config - Telegram media runtime limits.
 * @returns Fail-closed validation decision for the inbound update.
 */
export function validateTelegramMediaAttachments(
  attachments: readonly ConversationInboundMediaAttachment[],
  config: TelegramMediaRuntimeConfig = DEFAULT_TELEGRAM_MEDIA_RUNTIME_CONFIG
): MediaValidationDecision {
  if (attachments.length === 0) {
    return { accepted: true, message: null };
  }

  if (!config.enabled) {
    return {
      accepted: false,
      message: "Media input is disabled in this runtime."
    };
  }
  if (attachments.length > config.maxAttachmentCount) {
    return {
      accepted: false,
      message: `Media input rejected: more than ${config.maxAttachmentCount} attachments were provided.`
    };
  }

  for (const attachment of attachments) {
    if (
      (attachment.kind === "image" && !config.allowImages) ||
      (attachment.kind === "voice" && !config.allowVoiceNotes) ||
      (attachment.kind === "video" && !config.allowVideos) ||
      (attachment.kind === "document" && !config.allowDocuments)
    ) {
      return {
        accepted: false,
        message: `Media input rejected: ${attachment.kind} attachments are not enabled in this runtime.`
      };
    }
    if (
      typeof attachment.sizeBytes === "number" &&
      attachment.sizeBytes > config.maxAttachmentBytes
    ) {
      return {
        accepted: false,
        message: `Media input rejected: ${attachment.kind} exceeds the ${config.maxAttachmentBytes} byte limit.`
      };
    }
    if (
      attachment.kind === "voice" &&
      typeof attachment.durationSeconds === "number" &&
      attachment.durationSeconds > config.maxVoiceDurationSeconds
    ) {
      return {
        accepted: false,
        message: `Media input rejected: voice note exceeds the ${config.maxVoiceDurationSeconds} second limit.`
      };
    }
    if (
      attachment.kind === "video" &&
      typeof attachment.durationSeconds === "number" &&
      attachment.durationSeconds > config.maxVideoDurationSeconds
    ) {
      return {
        accepted: false,
        message: `Media input rejected: short video exceeds the ${config.maxVideoDurationSeconds} second limit.`
      };
    }
  }

  return { accepted: true, message: null };
}
