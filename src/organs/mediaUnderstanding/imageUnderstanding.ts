/**
 * @fileoverview Provider-backed bounded image understanding helpers.
 */

import type {
  ConversationInboundMediaAttachment,
  ConversationInboundMediaInterpretation
} from "../../interfaces/mediaRuntime/contracts";
import type { MediaUnderstandingConfig } from "./contracts";
import {
  describeMediaAuthorizationSource,
  resolveMediaAuthorizationHeaders
} from "./auth";
import { buildFallbackMediaInterpretation } from "./mediaModelFallback";
import {
  collectEntityHintsFromTexts,
  parseStructuredMediaOutput,
  sanitizeEntityHints
} from "./interpretationSupport";
import {
  extractOllamaChatOutputText,
  extractResponsesOutputText
} from "./providerSupport";

const IMAGE_INTERPRETATION_PROMPT = [
  "Return JSON only with keys summary, ocr_text, and entity_hints.",
  "Describe the attached image factually in one or two sentences.",
  "Put any clearly visible UI error text or readable text into ocr_text.",
  "Put likely business names, project names, or identifiers into entity_hints.",
  "Do not add markdown fences."
].join(" ");

interface VisionAttempt {
  backend: MediaUnderstandingConfig["resolvedVisionBackend"];
  model: string;
}

/**
 * Attempts bounded interpretation for one image attachment.
 *
 * @param config - Media-understanding provider config.
 * @param attachment - Image attachment metadata.
 * @param buffer - Downloaded image bytes.
 * @returns Provider-backed interpretation, or deterministic fallback when unavailable.
 */
export async function interpretImageAttachment(
  config: MediaUnderstandingConfig,
  attachment: ConversationInboundMediaAttachment,
  buffer: Buffer | null
): Promise<ConversationInboundMediaInterpretation> {
  if (!buffer) {
    return buildFallbackMediaInterpretation(attachment);
  }

  try {
    for (const attempt of buildVisionAttempts(config)) {
      const interpretation = await attemptImageInterpretation(
        config,
        attempt,
        attachment,
        buffer
      );
      if (interpretation) {
        return interpretation;
      }
    }
    return buildFallbackMediaInterpretation(attachment);
  } catch {
    return buildFallbackMediaInterpretation(attachment);
  }
}

/**
 * Builds vision attempts.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `MediaUnderstandingConfig` (import `MediaUnderstandingConfig`) from `./contracts`.
 * @param config - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function buildVisionAttempts(config: MediaUnderstandingConfig): readonly VisionAttempt[] {
  const attempts: VisionAttempt[] = [];
  if (config.resolvedVisionBackend !== "disabled") {
    attempts.push({
      backend: config.resolvedVisionBackend,
      model: config.visionModel
    });
  }
  if (
    config.resolvedVisionFallbackBackend !== "disabled"
    && config.visionFallbackModel
    && (
      config.resolvedVisionFallbackBackend !== config.resolvedVisionBackend
      || config.visionFallbackModel !== config.visionModel
    )
  ) {
    attempts.push({
      backend: config.resolvedVisionFallbackBackend,
      model: config.visionFallbackModel
    });
  }
  return attempts;
}

/**
 * Attempts image interpretation.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ConversationInboundMediaAttachment` (import `ConversationInboundMediaAttachment`) from `../../interfaces/mediaRuntime/contracts`.
 * - Uses `ConversationInboundMediaInterpretation` (import `ConversationInboundMediaInterpretation`) from `../../interfaces/mediaRuntime/contracts`.
 * - Uses `describeMediaAuthorizationSource` (import `describeMediaAuthorizationSource`) from `./auth`.
 * - Uses `resolveMediaAuthorizationHeaders` (import `resolveMediaAuthorizationHeaders`) from `./auth`.
 * - Uses `MediaUnderstandingConfig` (import `MediaUnderstandingConfig`) from `./contracts`.
 * - Uses `collectEntityHintsFromTexts` (import `collectEntityHintsFromTexts`) from `./interpretationSupport`.
 * - Uses `parseStructuredMediaOutput` (import `parseStructuredMediaOutput`) from `./interpretationSupport`.
 * - Uses `sanitizeEntityHints` (import `sanitizeEntityHints`) from `./interpretationSupport`.
 * - Uses `extractOllamaChatOutputText` (import `extractOllamaChatOutputText`) from `./providerSupport`.
 * - Uses `extractResponsesOutputText` (import `extractResponsesOutputText`) from `./providerSupport`.
 * @param config - Input consumed by this helper.
 * @param attempt - Input consumed by this helper.
 * @param attachment - Input consumed by this helper.
 * @param buffer - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
async function attemptImageInterpretation(
  config: MediaUnderstandingConfig,
  attempt: VisionAttempt,
  attachment: ConversationInboundMediaAttachment,
  buffer: Buffer
): Promise<ConversationInboundMediaInterpretation | null> {
  const attemptConfig = buildVisionAttemptConfig(config, attempt);
  const authorizationHeaders = await resolveMediaAuthorizationHeaders(attemptConfig, "vision");
  if (!authorizationHeaders) {
    return null;
  }
  const abortController = new AbortController();
  const timeoutMs = attempt.backend === "ollama"
    ? Math.max(attemptConfig.requestTimeoutMs, 120_000)
    : attemptConfig.requestTimeoutMs;
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const response = attempt.backend === "ollama"
      ? await fetchOllamaImageInterpretation(
          attemptConfig,
          attachment,
          buffer,
          authorizationHeaders,
          abortController.signal
        )
      : await fetchOpenAIImageInterpretation(
          attemptConfig,
          attachment,
          buffer,
          authorizationHeaders,
          abortController.signal
        );
    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    const rawOutput = attempt.backend === "ollama"
      ? extractOllamaChatOutputText(payload)
      : extractResponsesOutputText(payload);
    if (!rawOutput) {
      return null;
    }
    const structuredOutput = parseStructuredMediaOutput(rawOutput);
    const summary = structuredOutput?.summary ?? rawOutput;
    const ocrText = structuredOutput?.ocrText ?? null;
    const structuredEntityHints = structuredOutput?.entityHints ?? [];
    const entityHints = sanitizeEntityHints([
      ...structuredEntityHints,
      ...collectEntityHintsFromTexts([
        ocrText,
        summary,
        attachment.fileName,
        attachment.caption
      ])
    ]);
    return {
      summary,
      transcript: null,
      ocrText,
      confidence: 0.74,
      provenance: `${describeMediaAuthorizationSource(attemptConfig, "vision")} image summary model ${attempt.model}`,
      source: attempt.backend === "ollama" ? "ollama_image" : "openai_image",
      entityHints
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Builds vision attempt config.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `MediaUnderstandingConfig` (import `MediaUnderstandingConfig`) from `./contracts`.
 * @param config - Input consumed by this helper.
 * @param attempt - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function buildVisionAttemptConfig(
  config: MediaUnderstandingConfig,
  attempt: VisionAttempt
): MediaUnderstandingConfig {
  return {
    ...config,
    requestedVisionBackend: attempt.backend,
    resolvedVisionBackend: attempt.backend,
    visionModel: attempt.model,
    requestedVisionFallbackBackend: "disabled",
    resolvedVisionFallbackBackend: "disabled",
    visionFallbackModel: null
  };
}

/**
 * Fetches ollama image interpretation.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ConversationInboundMediaAttachment` (import `ConversationInboundMediaAttachment`) from `../../interfaces/mediaRuntime/contracts`.
 * - Uses `MediaUnderstandingConfig` (import `MediaUnderstandingConfig`) from `./contracts`.
 * @param config - Input consumed by this helper.
 * @param _attachment - Input consumed by this helper.
 * @param buffer - Input consumed by this helper.
 * @param authorizationHeaders - Input consumed by this helper.
 * @param signal - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function fetchOllamaImageInterpretation(
  config: MediaUnderstandingConfig,
  _attachment: ConversationInboundMediaAttachment,
  buffer: Buffer,
  authorizationHeaders: Record<string, string>,
  signal: AbortSignal
): Promise<Response> {
  return fetch(`${config.ollamaBaseUrl}/api/chat`, {
    method: "POST",
    headers: {
      ...authorizationHeaders,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.visionModel,
      messages: [
        {
          role: "user",
          content: IMAGE_INTERPRETATION_PROMPT,
          images: [buffer.toString("base64")]
        }
      ],
      format: {
        type: "object",
        properties: {
          summary: { type: "string" },
          ocr_text: { type: "string" },
          entity_hints: {
            type: "array",
            items: { type: "string" }
          }
        },
        required: ["summary", "ocr_text", "entity_hints"]
      },
      stream: false
    }),
    signal
  });
}

/**
 * Fetches open aiimage interpretation.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ConversationInboundMediaAttachment` (import `ConversationInboundMediaAttachment`) from `../../interfaces/mediaRuntime/contracts`.
 * - Uses `MediaUnderstandingConfig` (import `MediaUnderstandingConfig`) from `./contracts`.
 * @param config - Input consumed by this helper.
 * @param attachment - Input consumed by this helper.
 * @param buffer - Input consumed by this helper.
 * @param authorizationHeaders - Input consumed by this helper.
 * @param signal - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function fetchOpenAIImageInterpretation(
  config: MediaUnderstandingConfig,
  attachment: ConversationInboundMediaAttachment,
  buffer: Buffer,
  authorizationHeaders: Record<string, string>,
  signal: AbortSignal
): Promise<Response> {
  const mimeType = attachment.mimeType ?? "image/jpeg";
  const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
  return fetch(`${config.openAIBaseUrl}/responses`, {
    method: "POST",
    headers: {
      ...authorizationHeaders,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.visionModel,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: IMAGE_INTERPRETATION_PROMPT
            },
            {
              type: "input_image",
              image_url: dataUrl
            }
          ]
        }
      ]
    }),
    signal
  });
}
