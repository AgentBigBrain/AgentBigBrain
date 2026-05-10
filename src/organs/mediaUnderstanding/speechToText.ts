/**
 * @fileoverview Provider-backed speech-to-text helpers for bounded voice-note interpretation.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  resolveAudioFormat,
  resolveOllamaOpenAICompatibilityBaseUrl
} from "./providerSupport";

const AUDIO_TRANSCODER_TIMEOUT_MS = 30_000;

/**
 * Resolves the provider endpoint used for multimodal audio transcription requests.
 *
 * **Why it exists:**
 * Dedicated transcription models and multimodal chat models do not share the same transport
 * surface, and Ollama exposes its local Gemma audio path through the OpenAI-compatible `/v1`
 * boundary rather than the native `/api/chat` image-oriented shape.
 *
 * **What it talks to:**
 * - Uses `MediaUnderstandingConfig` (import type `MediaUnderstandingConfig`) from `./contracts`.
 * - Uses `resolveOllamaOpenAICompatibilityBaseUrl` from `./providerSupport`.
 *
 * @param config - Media-understanding provider config.
 * @returns Canonical base URL for multimodal audio transcription requests.
 */
function resolveMultimodalTranscriptionBaseUrl(
  config: MediaUnderstandingConfig
): string {
  return config.resolvedTranscriptionBackend === "ollama"
    ? resolveOllamaOpenAICompatibilityBaseUrl(config.ollamaBaseUrl)
    : config.openAIBaseUrl;
}

/**
 * Resolves the external audio transcoder command for Ollama voice-note normalization.
 *
 * **Why it exists:**
 * Telegram voice notes usually arrive as OGG/Opus, while Ollama's Gemma audio endpoint currently
 * accepts WAV reliably. Keeping the command lookup explicit avoids hiding a platform dependency
 * inside the transcription request path.
 *
 * **What it talks to:**
 * - Uses `MediaUnderstandingConfig` (import type `MediaUnderstandingConfig`) from `./contracts`.
 *
 * @param config - Media-understanding provider config.
 * @returns Configured FFmpeg-compatible command path, or `ffmpeg` for PATH lookup.
 */
function resolveAudioTranscoderPath(config: MediaUnderstandingConfig): string {
  const env = config.env ?? process.env;
  return env.BRAIN_MEDIA_AUDIO_TRANSCODER_PATH?.trim()
    || env.FFMPEG_PATH?.trim()
    || "ffmpeg";
}

/**
 * Runs the configured audio transcoder with a bounded timeout.
 *
 * **Why it exists:**
 * Transcoding is an optional local compatibility bridge for Ollama, so failures must stay bounded
 * and fall back instead of hanging the media pipeline.
 *
 * **What it talks to:**
 * - Uses `execFile` (import `execFile`) from `node:child_process`.
 *
 * @param command - FFmpeg-compatible executable path.
 * @param args - Command arguments for one bounded transcode.
 * @returns Promise that resolves when the command exits successfully.
 */
function runAudioTranscoder(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        timeout: AUDIO_TRANSCODER_TIMEOUT_MS,
        windowsHide: true
      },
      (error, _stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message;
          reject(new Error(`Audio transcoder failed: ${detail}`));
          return;
        }
        resolve();
      }
    );
  });
}

/**
 * Converts an audio buffer to 16 kHz mono WAV for Ollama Gemma audio input.
 *
 * **Why it exists:**
 * Ollama's current Gemma audio path transcribes WAV but rejects Telegram OGG/Opus files. A narrow
 * local transcode lets ABB keep voice-note transcription local while still failing closed if the
 * transcoder is unavailable.
 *
 * **What it talks to:**
 * - Uses `MediaUnderstandingConfig` (import type `MediaUnderstandingConfig`) from `./contracts`.
 * - Uses `mkdtemp`, `readFile`, `rm`, and `writeFile` (imports from `node:fs/promises`).
 * - Uses `tmpdir` (import `tmpdir`) from `node:os`.
 * - Uses `join` (import `join`) from `node:path`.
 * - Calls `resolveAudioTranscoderPath` and `runAudioTranscoder` within this module.
 *
 * @param config - Media-understanding provider config.
 * @param buffer - Original audio bytes.
 * @param extension - Detected original audio format.
 * @returns WAV bytes suitable for Ollama's transcription endpoint.
 */
async function transcodeAudioBufferToWav(
  config: MediaUnderstandingConfig,
  buffer: Buffer,
  extension: string
): Promise<Buffer> {
  const tempDir = await mkdtemp(join(tmpdir(), "agentbigbrain-audio-"));
  try {
    const inputPath = join(tempDir, `input.${extension}`);
    const outputPath = join(tempDir, "output.wav");
    await writeFile(inputPath, buffer);
    await runAudioTranscoder(resolveAudioTranscoderPath(config), [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-ac",
      "1",
      "-ar",
      "16000",
      outputPath
    ]);
    return await readFile(outputPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

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
    const transcriptionBackend = config.resolvedTranscriptionBackend;
    const usesDedicatedTranscriptionModel = isDedicatedTranscriptionModel(config.transcriptionModel);
    const usesTranscriptionEndpoint = usesDedicatedTranscriptionModel || transcriptionBackend === "ollama";
    const shouldTranscodeForOllama = transcriptionBackend === "ollama" && extension !== "wav";
    const uploadBuffer = shouldTranscodeForOllama
      ? await transcodeAudioBufferToWav(config, buffer, extension)
      : buffer;
    const uploadMimeType = shouldTranscodeForOllama ? "audio/wav" : mimeType;
    const uploadExtension = shouldTranscodeForOllama ? "wav" : extension;
    const uploadFileName = shouldTranscodeForOllama || !attachment.fileName
      ? `voice-note.${uploadExtension}`
      : attachment.fileName;
    let response: Response;
    if (usesTranscriptionEndpoint) {
      const formData = new FormData();
      formData.append("model", config.transcriptionModel);
      formData.append(
        "file",
        new Blob([Uint8Array.from(uploadBuffer)], { type: uploadMimeType }),
        uploadFileName
      );
      if (transcriptionBackend !== "ollama") {
        formData.append("response_format", "json");
      }

      response = await fetch(`${resolveMultimodalTranscriptionBaseUrl(config)}/audio/transcriptions`, {
        method: "POST",
        headers: authorizationHeaders,
        body: formData,
        signal: abortController.signal
      });
    } else {
      response = await fetch(`${resolveMultimodalTranscriptionBaseUrl(config)}/responses`, {
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
    const transcript = usesTranscriptionEndpoint
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
      source: usesDedicatedTranscriptionModel && transcriptionBackend !== "ollama"
        ? "openai_transcription"
        : "multimodal_audio",
      entityHints: []
    };
  } catch {
    return buildFallbackMediaInterpretation(attachment);
  }
}

