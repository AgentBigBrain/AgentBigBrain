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
    const authorizationHeaders = await resolveMediaAuthorizationHeaders(config, "vision");
    if (!authorizationHeaders) {
      return buildFallbackMediaInterpretation(attachment);
    }
    const abortController = new AbortController();
    const timeoutMs = config.resolvedVisionBackend === "ollama"
      ? Math.max(config.requestTimeoutMs, 120_000)
      : config.requestTimeoutMs;
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);
    const mimeType = attachment.mimeType ?? "image/jpeg";
    let response: Response;
    if (config.resolvedVisionBackend === "ollama") {
      response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
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
        signal: abortController.signal
      });
    } else {
      const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
      response = await fetch(`${config.openAIBaseUrl}/responses`, {
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
        signal: abortController.signal
      });
    }
    clearTimeout(timeout);
    if (!response.ok) {
      return buildFallbackMediaInterpretation(attachment);
    }
    const payload = await response.json();
    const rawOutput = config.resolvedVisionBackend === "ollama"
      ? extractOllamaChatOutputText(payload)
      : extractResponsesOutputText(payload);
    if (!rawOutput) {
      return buildFallbackMediaInterpretation(attachment);
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
      provenance: `${describeMediaAuthorizationSource(config, "vision")} image summary model ${config.visionModel}`,
      source: config.resolvedVisionBackend === "ollama" ? "ollama_image" : "openai_image",
      entityHints
    };
  } catch {
    return buildFallbackMediaInterpretation(attachment);
  }
}
