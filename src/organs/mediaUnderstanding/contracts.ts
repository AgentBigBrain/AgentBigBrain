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

export const DEFAULT_MEDIA_VISION_MODEL =
  process.env.BRAIN_MEDIA_VISION_MODEL?.trim()
  || process.env.OPENAI_MODEL_SMALL_FAST?.trim()
  || process.env.OLLAMA_MODEL_SMALL_FAST?.trim()
  || process.env.OLLAMA_MODEL_DEFAULT?.trim()
  || "gpt-4.1-mini";
export const DEFAULT_MEDIA_TRANSCRIPTION_MODEL = process.env.BRAIN_MEDIA_TRANSCRIPTION_MODEL?.trim() || "whisper-1";
export const DEFAULT_MEDIA_DOCUMENT_MEANING_MODEL =
  process.env.BRAIN_MEDIA_DOCUMENT_MEANING_MODEL?.trim()
  || process.env.OPENAI_MODEL_SMALL_FAST?.trim()
  || process.env.OLLAMA_MODEL_SMALL_FAST?.trim()
  || process.env.OLLAMA_MODEL_DEFAULT?.trim()
  || "gpt-4.1-mini";
export const DEFAULT_MEDIA_REQUEST_TIMEOUT_MS = 45_000;
export type MediaUnderstandingBackend = ModelBackend | "inherit_text_backend" | "disabled";
export type MediaUnderstandingModality = "vision" | "transcription" | "document_meaning";

export interface MediaUnderstandingConfig {
  requestedBackend: MediaUnderstandingBackend;
  resolvedBackend: ModelBackend | "disabled";
  requestedVisionBackend: MediaUnderstandingBackend;
  resolvedVisionBackend: ModelBackend | "disabled";
  requestedVisionFallbackBackend: MediaUnderstandingBackend;
  resolvedVisionFallbackBackend: ModelBackend | "disabled";
  requestedTranscriptionBackend: MediaUnderstandingBackend;
  resolvedTranscriptionBackend: ModelBackend | "disabled";
  requestedDocumentMeaningBackend?: MediaUnderstandingBackend;
  resolvedDocumentMeaningBackend?: ModelBackend | "disabled";
  openAIApiKey: string | null;
  openAIBaseUrl: string;
  ollamaApiKey: string | null;
  ollamaBaseUrl: string;
  visionModel: string;
  visionFallbackModel: string | null;
  transcriptionModel: string;
  documentMeaningModel?: string;
  documentMeaningTimeoutMs?: number;
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
  const requestedVisionFallbackBackend = resolveMediaUnderstandingBackend(
    process.env.BRAIN_MEDIA_VISION_FALLBACK_BACKEND ?? "disabled"
  );
  const resolvedVisionFallbackBackend = requestedVisionFallbackBackend === "inherit_text_backend"
    ? resolveModelBackendFromEnv(process.env)
    : requestedVisionFallbackBackend;
  const requestedTranscriptionBackend = resolveMediaUnderstandingBackend(
    process.env.BRAIN_MEDIA_TRANSCRIPTION_BACKEND ?? process.env.BRAIN_MEDIA_BACKEND
  );
  const resolvedTranscriptionBackend = requestedTranscriptionBackend === "inherit_text_backend"
    ? resolveModelBackendFromEnv(process.env)
    : requestedTranscriptionBackend;
  const requestedDocumentMeaningBackend = resolveMediaUnderstandingBackend(
    process.env.BRAIN_MEDIA_DOCUMENT_MEANING_BACKEND ?? "disabled"
  );
  const resolvedDocumentMeaningBackend = requestedDocumentMeaningBackend === "inherit_text_backend"
    ? resolveModelBackendFromEnv(process.env)
    : requestedDocumentMeaningBackend;
  return {
    requestedBackend,
    resolvedBackend,
    requestedVisionBackend,
    resolvedVisionBackend,
    requestedVisionFallbackBackend,
    resolvedVisionFallbackBackend,
    requestedTranscriptionBackend,
    resolvedTranscriptionBackend,
    requestedDocumentMeaningBackend,
    resolvedDocumentMeaningBackend,
    openAIApiKey:
      resolvedVisionBackend === "openai_api"
        || resolvedVisionFallbackBackend === "openai_api"
        || resolvedTranscriptionBackend === "openai_api"
        || resolvedDocumentMeaningBackend === "openai_api"
        ? process.env.OPENAI_API_KEY?.trim() || null
        : null,
    openAIBaseUrl: (process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, ""),
    ollamaApiKey:
      resolvedVisionBackend === "ollama"
        || resolvedVisionFallbackBackend === "ollama"
        || resolvedTranscriptionBackend === "ollama"
        || resolvedDocumentMeaningBackend === "ollama"
        ? process.env.OLLAMA_API_KEY?.trim() || null
        : null,
    ollamaBaseUrl: (process.env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434").replace(/\/+$/, ""),
    visionModel: process.env.BRAIN_MEDIA_VISION_MODEL?.trim() || DEFAULT_MEDIA_VISION_MODEL,
    visionFallbackModel: resolveVisionFallbackModel(
      resolvedVisionFallbackBackend,
      process.env
    ),
    transcriptionModel: process.env.BRAIN_MEDIA_TRANSCRIPTION_MODEL?.trim() || DEFAULT_MEDIA_TRANSCRIPTION_MODEL,
    documentMeaningModel:
      process.env.BRAIN_MEDIA_DOCUMENT_MEANING_MODEL?.trim() || DEFAULT_MEDIA_DOCUMENT_MEANING_MODEL,
    documentMeaningTimeoutMs: Number.isFinite(Number(process.env.BRAIN_MEDIA_DOCUMENT_MEANING_TIMEOUT_MS))
      ? Math.max(1_000, Number(process.env.BRAIN_MEDIA_DOCUMENT_MEANING_TIMEOUT_MS))
      : DEFAULT_MEDIA_REQUEST_TIMEOUT_MS,
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

/**
 * Resolves vision fallback model.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ModelBackend` (import `ModelBackend`) from `../../models/types`.
 * @param resolvedFallbackBackend - Input consumed by this helper.
 * @param env - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function resolveVisionFallbackModel(
  resolvedFallbackBackend: ModelBackend | "disabled",
  env: NodeJS.ProcessEnv
): string | null {
  const explicitModel = env.BRAIN_MEDIA_VISION_FALLBACK_MODEL?.trim();
  if (explicitModel) {
    return explicitModel;
  }
  if (resolvedFallbackBackend === "openai_api" || resolvedFallbackBackend === "codex_oauth") {
    return env.OPENAI_MODEL_MEDIUM_GENERAL?.trim()
      || env.OPENAI_MODEL_SMALL_FAST?.trim()
      || "gpt-4.1-mini";
  }
  if (resolvedFallbackBackend === "ollama") {
    return env.OLLAMA_MODEL_SMALL_FAST?.trim()
      || env.OLLAMA_MODEL_DEFAULT?.trim()
      || env.BRAIN_MEDIA_VISION_MODEL?.trim()
      || "gemma4:latest";
  }
  return null;
}
