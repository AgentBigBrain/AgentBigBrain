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
  resolveMediaAuthorizationToken
} from "./auth";
import { buildFallbackMediaInterpretation } from "./mediaModelFallback";

/**
 * Extracts the bounded summary text returned by the Responses API payload shape.
 *
 * @param payload - Raw JSON payload returned by the provider.
 * @returns Joined textual output extracted from the response structure.
 */
function extractResponsesOutputText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === "string") {
    return record.output_text.trim();
  }
  const output = Array.isArray(record.output) ? record.output : [];
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const content = Array.isArray((item as Record<string, unknown>).content)
      ? ((item as Record<string, unknown>).content as unknown[])
      : [];
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const blockRecord = block as Record<string, unknown>;
      if (typeof blockRecord.text === "string") {
        parts.push(blockRecord.text.trim());
      }
    }
  }
  return parts.join(" ").trim();
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
    const authorizationToken = await resolveMediaAuthorizationToken(config);
    if (!authorizationToken) {
      return buildFallbackMediaInterpretation(attachment);
    }
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), config.requestTimeoutMs);
    const mimeType = attachment.mimeType ?? "image/jpeg";
    const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
    const response = await fetch(`${config.openAIBaseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authorizationToken}`,
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
    clearTimeout(timeout);
    if (!response.ok) {
      return buildFallbackMediaInterpretation(attachment);
    }
    const payload = await response.json();
    const summary = extractResponsesOutputText(payload);
    if (!summary) {
      return buildFallbackMediaInterpretation(attachment);
    }
    return {
      summary,
      transcript: null,
      ocrText: null,
      confidence: 0.74,
      provenance: `${describeMediaAuthorizationSource(config)} image summary model ${config.visionModel}`,
      source: "openai_image",
      entityHints: []
    };
  } catch {
    return buildFallbackMediaInterpretation(attachment);
  }
}
