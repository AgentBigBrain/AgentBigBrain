/**
 * @fileoverview Provider-backed speech-to-text helpers for bounded voice-note interpretation.
 */

import type {
  ConversationInboundMediaAttachment,
  ConversationInboundMediaInterpretation
} from "../../interfaces/mediaRuntime/contracts";
import type { MediaUnderstandingConfig } from "./contracts";
import { buildFallbackMediaInterpretation } from "./mediaModelFallback";

/**
 * Attempts bounded transcription for one voice-note attachment.
 *
 * @param config - Media-understanding provider config.
 * @param attachment - Voice attachment metadata.
 * @param buffer - Downloaded voice-note bytes.
 * @returns Provider-backed interpretation, or deterministic fallback when unavailable.
 */
export async function interpretVoiceAttachment(
  config: MediaUnderstandingConfig,
  attachment: ConversationInboundMediaAttachment,
  buffer: Buffer | null
): Promise<ConversationInboundMediaInterpretation> {
  if (!buffer || !config.openAIApiKey) {
    return buildFallbackMediaInterpretation(attachment);
  }

  try {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), config.requestTimeoutMs);
    const formData = new FormData();
    formData.append("model", config.transcriptionModel);
    const mimeType = attachment.mimeType ?? "audio/ogg";
    const extension = mimeType.includes("mpeg") ? "mp3" : mimeType.includes("wav") ? "wav" : "ogg";
    formData.append(
      "file",
      new Blob([Uint8Array.from(buffer)], { type: mimeType }),
      attachment.fileName ?? `voice-note.${extension}`
    );
    formData.append("response_format", "json");

    const response = await fetch(`${config.openAIBaseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openAIApiKey}`
      },
      body: formData,
      signal: abortController.signal
    });
    clearTimeout(timeout);
    if (!response.ok) {
      return buildFallbackMediaInterpretation(attachment);
    }

    const payload = await response.json() as { text?: string };
    const transcript = (payload.text ?? "").trim();
    if (!transcript) {
      return buildFallbackMediaInterpretation(attachment);
    }

    return {
      summary: `The user attached a voice note. Transcript: ${transcript}`,
      transcript,
      ocrText: null,
      confidence: 0.82,
      provenance: `OpenAI transcription model ${config.transcriptionModel}`,
      source: "openai_transcription",
      entityHints: []
    };
  } catch {
    return buildFallbackMediaInterpretation(attachment);
  }
}

