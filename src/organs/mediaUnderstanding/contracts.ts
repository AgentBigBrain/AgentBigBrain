/**
 * @fileoverview Canonical contracts for bounded media understanding across Telegram image, voice, video, and document attachments.
 */

import type {
  ConversationInboundMediaAttachment,
  ConversationInboundMediaEnvelope,
  ConversationInboundMediaInterpretation
} from "../../interfaces/mediaRuntime/contracts";

export const DEFAULT_MEDIA_VISION_MODEL = process.env.BRAIN_MEDIA_VISION_MODEL?.trim() || process.env.OPENAI_MODEL_SMALL_FAST?.trim() || "gpt-4.1-mini";
export const DEFAULT_MEDIA_TRANSCRIPTION_MODEL = process.env.BRAIN_MEDIA_TRANSCRIPTION_MODEL?.trim() || "whisper-1";
export const DEFAULT_MEDIA_REQUEST_TIMEOUT_MS = 45_000;

export interface MediaUnderstandingConfig {
  openAIApiKey: string | null;
  openAIBaseUrl: string;
  visionModel: string;
  transcriptionModel: string;
  requestTimeoutMs: number;
}

export interface MediaAttachmentInterpretationInput {
  attachment: ConversationInboundMediaAttachment;
  buffer: Buffer | null;
}

export interface MediaInterpretationFixtureCatalog {
  readonly [sha256: string]: ConversationInboundMediaInterpretation;
}

export interface InterpretedConversationMediaEnvelope extends ConversationInboundMediaEnvelope {
  attachments: readonly ConversationInboundMediaAttachment[];
}

/**
 * Builds media-understanding config from env-backed defaults.
 *
 * @returns Stable provider/runtime config for bounded media interpretation.
 */
export function createMediaUnderstandingConfigFromEnv(): MediaUnderstandingConfig {
  return {
    openAIApiKey: process.env.OPENAI_API_KEY?.trim() || null,
    openAIBaseUrl: (process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, ""),
    visionModel: process.env.BRAIN_MEDIA_VISION_MODEL?.trim() || DEFAULT_MEDIA_VISION_MODEL,
    transcriptionModel: process.env.BRAIN_MEDIA_TRANSCRIPTION_MODEL?.trim() || DEFAULT_MEDIA_TRANSCRIPTION_MODEL,
    requestTimeoutMs: Number.isFinite(Number(process.env.BRAIN_MEDIA_REQUEST_TIMEOUT_MS))
      ? Math.max(1_000, Number(process.env.BRAIN_MEDIA_REQUEST_TIMEOUT_MS))
      : DEFAULT_MEDIA_REQUEST_TIMEOUT_MS
  };
}
