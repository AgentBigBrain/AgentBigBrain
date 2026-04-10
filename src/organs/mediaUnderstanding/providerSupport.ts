/**
 * @fileoverview Shared provider helpers for bounded media-understanding requests.
 */

interface OpenAIResponsesOutputBlock {
  text?: string;
}

interface OpenAIResponsesOutputItem {
  content?: OpenAIResponsesOutputBlock[];
}

interface OllamaChatResponse {
  message?: {
    content?: string;
  };
}

/**
 * Extracts joined textual output from an OpenAI-compatible `/responses` payload.
 *
 * @param payload - Raw JSON payload returned by the provider.
 * @returns Joined textual output extracted from the response structure.
 */
export function extractResponsesOutputText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === "string") {
    return record.output_text.trim();
  }
  const output = Array.isArray(record.output) ? (record.output as OpenAIResponsesOutputItem[]) : [];
  const parts: string[] = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const block of content) {
      if (typeof block?.text === "string") {
        parts.push(block.text.trim());
      }
    }
  }
  return parts.join(" ").trim();
}

/**
 * Extracts joined textual output from an Ollama `/api/chat` payload.
 *
 * @param payload - Raw JSON payload returned by Ollama.
 * @returns Assistant message text when present.
 */
export function extractOllamaChatOutputText(payload: unknown): string {
  const content = (payload as OllamaChatResponse | null)?.message?.content;
  return typeof content === "string" ? content.trim() : "";
}

/**
 * Returns `true` when the configured OpenAI-compatible base URL resolves to a local loopback host.
 *
 * @param baseUrl - OpenAI-compatible provider base URL.
 * @returns `true` when the URL points at a local host and can safely omit auth headers.
 */
export function isLocalOpenAICompatibleBaseUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.trim().toLowerCase();
    return hostname === "localhost"
      || hostname === "127.0.0.1"
      || hostname === "::1"
      || hostname === "0.0.0.0"
      || hostname === "host.docker.internal";
  } catch {
    return false;
  }
}

/**
 * Resolves the OpenAI-compatible base URL exposed by Ollama.
 *
 * **Why it exists:**
 * The media runtime should treat Ollama as its own backend while still targeting the compatibility
 * surface Ollama exposes for multimodal requests. Centralizing that URL normalization keeps audio
 * routing deterministic instead of scattering `/v1` handling across callers.
 *
 * **What it talks to:**
 * - Uses local string normalization helpers within this module.
 *
 * @param baseUrl - Configured Ollama base URL, with or without the `/v1` suffix.
 * @returns Canonical base URL that targets Ollama's OpenAI-compatible surface.
 */
export function resolveOllamaOpenAICompatibilityBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "http://localhost:11434/v1";
  }
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/**
 * Returns the audio format token used by multimodal chat-style providers.
 *
 * @param mimeType - Attachment MIME type when known.
 * @param fileName - Attachment file name when known.
 * @returns Lowercase audio format token.
 */
export function resolveAudioFormat(
  mimeType: string | null | undefined,
  fileName: string | null | undefined
): string {
  const normalizedMimeType = (mimeType ?? "").trim().toLowerCase();
  if (normalizedMimeType.includes("mpeg")) {
    return "mp3";
  }
  if (normalizedMimeType.includes("wav")) {
    return "wav";
  }
  if (normalizedMimeType.includes("ogg") || normalizedMimeType.includes("opus")) {
    return "ogg";
  }
  const normalizedFileName = (fileName ?? "").trim().toLowerCase();
  if (normalizedFileName.endsWith(".mp3")) {
    return "mp3";
  }
  if (normalizedFileName.endsWith(".wav")) {
    return "wav";
  }
  if (normalizedFileName.endsWith(".ogg") || normalizedFileName.endsWith(".opus")) {
    return "ogg";
  }
  return "ogg";
}

/**
 * Returns `true` when the configured transcription model is a dedicated speech-to-text endpoint
 * rather than a multimodal chat model.
 *
 * @param model - Configured transcription model id.
 * @returns `true` when the runtime should keep using `/audio/transcriptions`.
 */
export function isDedicatedTranscriptionModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized === "whisper-1"
    || normalized.startsWith("whisper")
    || normalized.endsWith("-transcribe")
    || normalized.includes("transcribe");
}
