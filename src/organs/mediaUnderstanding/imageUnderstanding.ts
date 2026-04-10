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
  extractOllamaChatOutputText,
  extractResponsesOutputText
} from "./providerSupport";

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
    const timeout = setTimeout(() => abortController.abort(), config.requestTimeoutMs);
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
              content: "Summarize the attached image in one or two sentences for a coding assistant. Include any visible UI error text or OCR when clear. Keep it factual and bounded.",
              images: [buffer.toString("base64")]
            }
          ],
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
                  text: "Summarize the attached image in one or two sentences for a coding assistant. Include any visible UI error text or OCR when clear. Keep it factual and bounded."
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
    const summary = config.resolvedVisionBackend === "ollama"
      ? extractOllamaChatOutputText(payload)
      : extractResponsesOutputText(payload);
    if (!summary) {
      return buildFallbackMediaInterpretation(attachment);
    }
    return {
      summary,
      transcript: null,
      ocrText: null,
      confidence: 0.74,
      provenance: `${describeMediaAuthorizationSource(config, "vision")} image summary model ${config.visionModel}`,
      source: config.resolvedVisionBackend === "ollama" ? "ollama_image" : "openai_image",
      entityHints: []
    };
  } catch {
    return buildFallbackMediaInterpretation(attachment);
  }
}
