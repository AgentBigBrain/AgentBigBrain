/**
 * @fileoverview Provider-backed speech-to-text helpers for bounded voice-note interpretation.
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
  extractResponsesOutputText,
  isDedicatedTranscriptionModel,
  resolveAudioFormat
} from "./providerSupport";

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
  if (!buffer) {
    return buildFallbackMediaInterpretation(attachment);
  }

  try {
    const authorizationHeaders = await resolveMediaAuthorizationHeaders(config, "transcription");
    if (!authorizationHeaders) {
      return buildFallbackMediaInterpretation(attachment);
    }
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), config.requestTimeoutMs);
    const mimeType = attachment.mimeType ?? "audio/ogg";
    const extension = resolveAudioFormat(mimeType, attachment.fileName);
    let response: Response;
    if (isDedicatedTranscriptionModel(config.transcriptionModel)) {
      const formData = new FormData();
      formData.append("model", config.transcriptionModel);
      formData.append(
        "file",
        new Blob([Uint8Array.from(buffer)], { type: mimeType }),
        attachment.fileName ?? `voice-note.${extension}`
      );
      formData.append("response_format", "json");

      response = await fetch(`${config.openAIBaseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: authorizationHeaders,
        body: formData,
        signal: abortController.signal
      });
    } else {
      response = await fetch(`${config.openAIBaseUrl}/responses`, {
        method: "POST",
        headers: {
          ...authorizationHeaders,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: config.transcriptionModel,
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "Transcribe the attached audio segment in its original language. Only output the transcription text with no speaker labels or extra commentary."
                },
                {
                  type: "input_audio",
                  input_audio: {
                    data: buffer.toString("base64"),
                    format: extension
                  }
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
    const payload = await response.json() as { text?: string };
    const transcript = isDedicatedTranscriptionModel(config.transcriptionModel)
      ? (payload.text ?? "").trim()
      : extractResponsesOutputText(payload);
    if (!transcript) {
      return buildFallbackMediaInterpretation(attachment);
    }

    return {
      summary: `The user attached a voice note. Transcript: ${transcript}`,
      transcript,
      ocrText: null,
      confidence: 0.82,
      provenance: `${describeMediaAuthorizationSource(config, "transcription")} transcription model ${config.transcriptionModel}`,
      source: isDedicatedTranscriptionModel(config.transcriptionModel)
        ? "openai_transcription"
        : "multimodal_audio",
      entityHints: []
    };
  } catch {
    return buildFallbackMediaInterpretation(attachment);
  }
}

