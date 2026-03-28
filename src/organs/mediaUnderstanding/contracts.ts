/**
 * @fileoverview Canonical contracts for bounded media understanding across Telegram image, voice, video, and document attachments.
 */

import type {
  ConversationInboundMediaAttachment,
  ConversationInboundMediaEnvelope,
  ConversationInboundMediaInterpretation
} from "../../interfaces/mediaRuntime/contracts";
import type { ModelBackend } from "../../models/types";
import { resolveModelBackendFromEnv } from "../../models/backendConfig";

export const DEFAULT_MEDIA_VISION_MODEL = process.env.BRAIN_MEDIA_VISION_MODEL?.trim() || process.env.OPENAI_MODEL_SMALL_FAST?.trim() || "gpt-4.1-mini";
export const DEFAULT_MEDIA_TRANSCRIPTION_MODEL = process.env.BRAIN_MEDIA_TRANSCRIPTION_MODEL?.trim() || "whisper-1";
export const DEFAULT_MEDIA_REQUEST_TIMEOUT_MS = 45_000;
export type MediaUnderstandingBackend = ModelBackend | "inherit_text_backend" | "disabled";
export type MediaUnderstandingModality = "vision" | "transcription";

export interface MediaUnderstandingConfig {
  requestedBackend: MediaUnderstandingBackend;
  resolvedBackend: ModelBackend | "disabled";
  requestedVisionBackend: MediaUnderstandingBackend;
  resolvedVisionBackend: ModelBackend | "disabled";
  requestedTranscriptionBackend: MediaUnderstandingBackend;
  resolvedTranscriptionBackend: ModelBackend | "disabled";
  openAIApiKey: string | null;
  openAIBaseUrl: string;
  visionModel: string;
  transcriptionModel: string;
  requestTimeoutMs: number;
  env?: NodeJS.ProcessEnv;
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
  const requestedBackend = resolveMediaUnderstandingBackend(process.env.BRAIN_MEDIA_BACKEND);
  const resolvedBackend = requestedBackend === "inherit_text_backend"
    ? resolveModelBackendFromEnv(process.env)
    : requestedBackend;
  const requestedVisionBackend = resolveMediaUnderstandingBackend(
    process.env.BRAIN_MEDIA_VISION_BACKEND ?? process.env.BRAIN_MEDIA_BACKEND
  );
  const resolvedVisionBackend = requestedVisionBackend === "inherit_text_backend"
    ? resolveModelBackendFromEnv(process.env)
    : requestedVisionBackend;
  const requestedTranscriptionBackend = resolveMediaUnderstandingBackend(
    process.env.BRAIN_MEDIA_TRANSCRIPTION_BACKEND ?? process.env.BRAIN_MEDIA_BACKEND
  );
  const resolvedTranscriptionBackend = requestedTranscriptionBackend === "inherit_text_backend"
    ? resolveModelBackendFromEnv(process.env)
    : requestedTranscriptionBackend;
  return {
    requestedBackend,
    resolvedBackend,
    requestedVisionBackend,
    resolvedVisionBackend,
    requestedTranscriptionBackend,
    resolvedTranscriptionBackend,
    openAIApiKey:
      resolvedVisionBackend === "openai_api" || resolvedTranscriptionBackend === "openai_api"
        ? process.env.OPENAI_API_KEY?.trim() || null
        : null,
    openAIBaseUrl: (process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, ""),
    visionModel: process.env.BRAIN_MEDIA_VISION_MODEL?.trim() || DEFAULT_MEDIA_VISION_MODEL,
    transcriptionModel: process.env.BRAIN_MEDIA_TRANSCRIPTION_MODEL?.trim() || DEFAULT_MEDIA_TRANSCRIPTION_MODEL,
    requestTimeoutMs: Number.isFinite(Number(process.env.BRAIN_MEDIA_REQUEST_TIMEOUT_MS))
      ? Math.max(1_000, Number(process.env.BRAIN_MEDIA_REQUEST_TIMEOUT_MS))
      : DEFAULT_MEDIA_REQUEST_TIMEOUT_MS,
    env: process.env
  };
}

/**
 * Resolves the configured media backend into one canonical runtime value.
 *
 * @param value - Raw media backend environment value.
 * @returns Canonical media backend identifier.
 */
export function resolveMediaUnderstandingBackend(
  value: string | undefined
): MediaUnderstandingBackend {
  const normalized = (value ?? "inherit_text_backend").trim().toLowerCase();
  if (normalized === "" || normalized === "inherit" || normalized === "inherit_text_backend") {
    return "inherit_text_backend";
  }
  if (normalized === "openai_api" || normalized === "openai") {
    return "openai_api";
  }
  if (normalized === "disabled") {
    return "disabled";
  }
  if (normalized === "codex_oauth") {
    return "codex_oauth";
  }
  if (normalized === "ollama") {
    return "ollama";
  }
  if (normalized === "mock") {
    return "mock";
  }
  throw new Error(
    `Unsupported BRAIN_MEDIA_BACKEND="${value ?? ""}". ` +
    "Expected one of openai_api, codex_oauth, ollama, mock, inherit_text_backend, or disabled."
  );
}
