/**
 * @fileoverview Verifies bounded media-understanding helpers and deterministic fixture interpretation.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { ConversationInboundMediaEnvelope } from "../../src/interfaces/mediaRuntime/contracts";
import { createMediaUnderstandingConfigFromEnv } from "../../src/organs/mediaUnderstanding/contracts";
import {
  computeMediaFixtureKey,
  interpretMediaAttachment,
  MediaUnderstandingOrgan
} from "../../src/organs/mediaUnderstanding/mediaInterpretation";
import { interpretDocumentAttachment } from "../../src/organs/mediaUnderstanding/documentUnderstanding";
import { interpretImageAttachment } from "../../src/organs/mediaUnderstanding/imageUnderstanding";
import { interpretVoiceAttachment } from "../../src/organs/mediaUnderstanding/speechToText";

test("createMediaUnderstandingConfigFromEnv falls back to bounded defaults", () => {
  const originalEnv = {
    BRAIN_MODEL_BACKEND: process.env.BRAIN_MODEL_BACKEND,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_MODEL_SMALL_FAST: process.env.OPENAI_MODEL_SMALL_FAST,
    CODEX_MODEL_SMALL_FAST: process.env.CODEX_MODEL_SMALL_FAST,
    BRAIN_MEDIA_BACKEND: process.env.BRAIN_MEDIA_BACKEND,
    BRAIN_MEDIA_VISION_BACKEND: process.env.BRAIN_MEDIA_VISION_BACKEND,
    BRAIN_MEDIA_TRANSCRIPTION_BACKEND: process.env.BRAIN_MEDIA_TRANSCRIPTION_BACKEND,
    BRAIN_MEDIA_VISION_MODEL: process.env.BRAIN_MEDIA_VISION_MODEL,
    BRAIN_MEDIA_TRANSCRIPTION_MODEL: process.env.BRAIN_MEDIA_TRANSCRIPTION_MODEL,
    BRAIN_MEDIA_REQUEST_TIMEOUT_MS: process.env.BRAIN_MEDIA_REQUEST_TIMEOUT_MS
  };

  delete process.env.BRAIN_MODEL_BACKEND;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_MODEL_SMALL_FAST;
  delete process.env.CODEX_MODEL_SMALL_FAST;
  delete process.env.BRAIN_MEDIA_BACKEND;
  delete process.env.BRAIN_MEDIA_VISION_BACKEND;
  delete process.env.BRAIN_MEDIA_TRANSCRIPTION_BACKEND;
  delete process.env.BRAIN_MEDIA_VISION_MODEL;
  delete process.env.BRAIN_MEDIA_TRANSCRIPTION_MODEL;
  delete process.env.BRAIN_MEDIA_REQUEST_TIMEOUT_MS;

  try {
    const config = createMediaUnderstandingConfigFromEnv();
    assert.equal(config.requestedBackend, "inherit_text_backend");
    assert.equal(config.resolvedBackend, "mock");
    assert.equal(config.requestedVisionBackend, "inherit_text_backend");
    assert.equal(config.resolvedVisionBackend, "mock");
    assert.equal(config.requestedTranscriptionBackend, "inherit_text_backend");
    assert.equal(config.resolvedTranscriptionBackend, "mock");
    assert.equal(config.openAIApiKey, null);
    assert.equal(config.openAIBaseUrl, "https://api.openai.com/v1");
    assert.ok(config.requestTimeoutMs >= 1_000);
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("createMediaUnderstandingConfigFromEnv can keep media on the explicit OpenAI API path when the main backend is codex_oauth", () => {
  const originalEnv = {
    BRAIN_MODEL_BACKEND: process.env.BRAIN_MODEL_BACKEND,
    BRAIN_MEDIA_BACKEND: process.env.BRAIN_MEDIA_BACKEND,
    BRAIN_MEDIA_VISION_BACKEND: process.env.BRAIN_MEDIA_VISION_BACKEND,
    BRAIN_MEDIA_TRANSCRIPTION_BACKEND: process.env.BRAIN_MEDIA_TRANSCRIPTION_BACKEND,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_MODEL_SMALL_FAST: process.env.OPENAI_MODEL_SMALL_FAST,
    CODEX_MODEL_SMALL_FAST: process.env.CODEX_MODEL_SMALL_FAST,
    BRAIN_MEDIA_VISION_MODEL: process.env.BRAIN_MEDIA_VISION_MODEL
  };

  process.env.BRAIN_MODEL_BACKEND = "codex_oauth";
  process.env.BRAIN_MEDIA_BACKEND = "openai_api";
  delete process.env.BRAIN_MEDIA_VISION_BACKEND;
  delete process.env.BRAIN_MEDIA_TRANSCRIPTION_BACKEND;
  delete process.env.OPENAI_API_KEY;
  process.env.OPENAI_MODEL_SMALL_FAST = "gpt-4.1-mini";
  process.env.CODEX_MODEL_SMALL_FAST = "gpt-5.4-mini";
  delete process.env.BRAIN_MEDIA_VISION_MODEL;

  try {
    const config = createMediaUnderstandingConfigFromEnv();
    assert.equal(config.requestedBackend, "openai_api");
    assert.equal(config.resolvedBackend, "openai_api");
    assert.equal(config.requestedVisionBackend, "openai_api");
    assert.equal(config.resolvedVisionBackend, "openai_api");
    assert.equal(config.requestedTranscriptionBackend, "openai_api");
    assert.equal(config.resolvedTranscriptionBackend, "openai_api");
    assert.equal(config.openAIApiKey, null);
    assert.equal(config.visionModel, "gpt-4.1-mini");
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("createMediaUnderstandingConfigFromEnv can inherit the text backend and fail closed for unsupported Codex media paths", () => {
  const originalEnv = {
    BRAIN_MODEL_BACKEND: process.env.BRAIN_MODEL_BACKEND,
    BRAIN_MEDIA_BACKEND: process.env.BRAIN_MEDIA_BACKEND,
    BRAIN_MEDIA_VISION_BACKEND: process.env.BRAIN_MEDIA_VISION_BACKEND,
    BRAIN_MEDIA_TRANSCRIPTION_BACKEND: process.env.BRAIN_MEDIA_TRANSCRIPTION_BACKEND,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY
  };

  process.env.BRAIN_MODEL_BACKEND = "codex_oauth";
  process.env.BRAIN_MEDIA_BACKEND = "inherit_text_backend";
  delete process.env.BRAIN_MEDIA_VISION_BACKEND;
  delete process.env.BRAIN_MEDIA_TRANSCRIPTION_BACKEND;
  process.env.OPENAI_API_KEY = "sk-test";

  try {
    const config = createMediaUnderstandingConfigFromEnv();
    assert.equal(config.requestedBackend, "inherit_text_backend");
    assert.equal(config.resolvedBackend, "codex_oauth");
    assert.equal(config.requestedVisionBackend, "inherit_text_backend");
    assert.equal(config.resolvedVisionBackend, "codex_oauth");
    assert.equal(config.requestedTranscriptionBackend, "inherit_text_backend");
    assert.equal(config.resolvedTranscriptionBackend, "codex_oauth");
    assert.equal(config.openAIApiKey, null);
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("createMediaUnderstandingConfigFromEnv can split vision and transcription backends by modality", () => {
  const originalEnv = {
    BRAIN_MODEL_BACKEND: process.env.BRAIN_MODEL_BACKEND,
    BRAIN_MEDIA_BACKEND: process.env.BRAIN_MEDIA_BACKEND,
    BRAIN_MEDIA_VISION_BACKEND: process.env.BRAIN_MEDIA_VISION_BACKEND,
    BRAIN_MEDIA_TRANSCRIPTION_BACKEND: process.env.BRAIN_MEDIA_TRANSCRIPTION_BACKEND,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY
  };

  process.env.BRAIN_MODEL_BACKEND = "codex_oauth";
  process.env.BRAIN_MEDIA_BACKEND = "inherit_text_backend";
  process.env.BRAIN_MEDIA_VISION_BACKEND = "codex_oauth";
  process.env.BRAIN_MEDIA_TRANSCRIPTION_BACKEND = "openai_api";
  process.env.OPENAI_API_KEY = "sk-test";

  try {
    const config = createMediaUnderstandingConfigFromEnv();
    assert.equal(config.requestedBackend, "inherit_text_backend");
    assert.equal(config.resolvedBackend, "codex_oauth");
    assert.equal(config.requestedVisionBackend, "codex_oauth");
    assert.equal(config.resolvedVisionBackend, "codex_oauth");
    assert.equal(config.requestedTranscriptionBackend, "openai_api");
    assert.equal(config.resolvedTranscriptionBackend, "openai_api");
    assert.equal(config.openAIApiKey, "sk-test");
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("createMediaUnderstandingConfigFromEnv can configure a distinct fallback vision backend", () => {
  const originalEnv = {
    BRAIN_MODEL_BACKEND: process.env.BRAIN_MODEL_BACKEND,
    BRAIN_MEDIA_BACKEND: process.env.BRAIN_MEDIA_BACKEND,
    BRAIN_MEDIA_VISION_BACKEND: process.env.BRAIN_MEDIA_VISION_BACKEND,
    BRAIN_MEDIA_VISION_FALLBACK_BACKEND: process.env.BRAIN_MEDIA_VISION_FALLBACK_BACKEND,
    BRAIN_MEDIA_VISION_FALLBACK_MODEL: process.env.BRAIN_MEDIA_VISION_FALLBACK_MODEL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_MODEL_MEDIUM_GENERAL: process.env.OPENAI_MODEL_MEDIUM_GENERAL
  };

  process.env.BRAIN_MODEL_BACKEND = "ollama";
  process.env.BRAIN_MEDIA_BACKEND = "inherit_text_backend";
  process.env.BRAIN_MEDIA_VISION_BACKEND = "ollama";
  process.env.BRAIN_MEDIA_VISION_FALLBACK_BACKEND = "openai_api";
  delete process.env.BRAIN_MEDIA_VISION_FALLBACK_MODEL;
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.OPENAI_MODEL_MEDIUM_GENERAL = "gpt-5-mini";

  try {
    const config = createMediaUnderstandingConfigFromEnv();
    assert.equal(config.requestedVisionBackend, "ollama");
    assert.equal(config.resolvedVisionBackend, "ollama");
    assert.equal(config.requestedVisionFallbackBackend, "openai_api");
    assert.equal(config.resolvedVisionFallbackBackend, "openai_api");
    assert.equal(config.visionFallbackModel, "gpt-5-mini");
    assert.equal(config.openAIApiKey, "sk-test");
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("interpretImageAttachment uses the Codex bearer token when media inherits the Codex backend", async () => {
  const originalFetch = globalThis.fetch;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-media-codex-"));
  try {
    const profileDir = path.join(tempDir, "default");
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      path.join(profileDir, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: "codex-access-token",
          refresh_token: "refresh-token"
        }
      }),
      "utf8"
    );

    let seenAuthorizationHeader: string | null = null;
    globalThis.fetch = (async (_input, init) => {
      seenAuthorizationHeader = new Headers(init?.headers).get("Authorization");
      return new Response(
        JSON.stringify({
          output_text: "Codex-backed image summary."
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }) as typeof fetch;

    const interpretation = await interpretImageAttachment(
      {
        requestedBackend: "inherit_text_backend",
        resolvedBackend: "codex_oauth",
        requestedVisionBackend: "codex_oauth",
        resolvedVisionBackend: "codex_oauth",
        requestedVisionFallbackBackend: "disabled",
        resolvedVisionFallbackBackend: "disabled",
        requestedTranscriptionBackend: "inherit_text_backend",
        resolvedTranscriptionBackend: "codex_oauth",
        openAIApiKey: null,
        openAIBaseUrl: "https://api.openai.com/v1",
        ollamaApiKey: null,
        ollamaBaseUrl: "http://localhost:11434",
        visionModel: "gpt-5.4-mini",
        visionFallbackModel: null,
        transcriptionModel: "whisper-1",
        requestTimeoutMs: 45_000,
        env: {
          CODEX_AUTH_STATE_DIR: tempDir,
          HOME: tempDir,
          USERPROFILE: tempDir
        }
      },
      {
        kind: "image",
        provider: "telegram",
        fileId: "image-codex-1",
        fileUniqueId: "image-codex-1",
        mimeType: "image/png",
        fileName: "ui.png",
        sizeBytes: 2048,
        caption: null,
        durationSeconds: null,
        width: 1280,
        height: 720
      },
      Buffer.from("png-data", "utf8")
    );

    assert.equal(seenAuthorizationHeader, "Bearer codex-access-token");
    assert.equal(interpretation.summary, "Codex-backed image summary.");
    assert.match(interpretation.provenance, /Codex OAuth-backed OpenAI image summary model gpt-5\.4-mini/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("computeMediaFixtureKey returns a stable sha256 digest", () => {
  const first = computeMediaFixtureKey(Buffer.from("fixture-one", "utf8"));
  const second = computeMediaFixtureKey(Buffer.from("fixture-one", "utf8"));
  const different = computeMediaFixtureKey(Buffer.from("fixture-two", "utf8"));

  assert.equal(first, second);
  assert.notEqual(first, different);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test("interpretMediaAttachment prefers fixture catalog entries over fallback logic", async () => {
  const buffer = Buffer.from("voice fixture", "utf8");
  const fixtureKey = computeMediaFixtureKey(buffer);
    const interpretation = await interpretMediaAttachment(
      {
        requestedBackend: "openai_api",
        resolvedBackend: "openai_api",
        requestedVisionBackend: "openai_api",
        resolvedVisionBackend: "openai_api",
        requestedVisionFallbackBackend: "disabled",
        resolvedVisionFallbackBackend: "disabled",
        requestedTranscriptionBackend: "openai_api",
        resolvedTranscriptionBackend: "openai_api",
        openAIApiKey: null,
        openAIBaseUrl: "https://api.openai.com/v1",
        ollamaApiKey: null,
        ollamaBaseUrl: "http://localhost:11434",
        visionModel: "gpt-4.1-mini",
        visionFallbackModel: null,
        transcriptionModel: "whisper-1",
        requestTimeoutMs: 45_000
      },
      {
      attachment: {
        kind: "voice",
        provider: "telegram",
        fileId: "voice-1",
        fileUniqueId: "voice-uniq-1",
        mimeType: "audio/ogg",
        fileName: null,
        sizeBytes: 1024,
        caption: null,
        durationSeconds: 9,
        width: null,
        height: null
      },
      buffer
    },
    {
      [fixtureKey]: {
        summary: "Fixture transcript summary.",
        transcript: "Please fix the planner issue.",
        ocrText: null,
        confidence: 0.97,
        provenance: "deterministic fixture catalog",
        source: "fixture_catalog",
        entityHints: ["planner", "issue"]
      }
    }
  );

  assert.equal(interpretation.source, "fixture_catalog");
  assert.match(interpretation.provenance, /fixture/);
  assert.equal(interpretation.transcript, "Please fix the planner issue.");
});

test("MediaUnderstandingOrgan enriches all attachments in one envelope", async () => {
  const imageBuffer = Buffer.from("image fixture", "utf8");
  const voiceBuffer = Buffer.from("voice fixture two", "utf8");
  const envelope: ConversationInboundMediaEnvelope = {
    attachments: [
      {
        kind: "image",
        provider: "telegram",
        fileId: "image-1",
        fileUniqueId: "image-uniq-1",
        mimeType: "image/png",
        fileName: "failure.png",
        sizeBytes: 4096,
        caption: "You did this wrong.",
        durationSeconds: null,
        width: 1280,
        height: 720
      },
      {
        kind: "voice",
        provider: "telegram",
        fileId: "voice-2",
        fileUniqueId: "voice-uniq-2",
        mimeType: "audio/ogg",
        fileName: null,
        sizeBytes: 2048,
        caption: null,
        durationSeconds: 15,
        width: null,
        height: null
      }
    ]
  };
  const organ = new MediaUnderstandingOrgan(
    {
      requestedBackend: "openai_api",
      resolvedBackend: "openai_api",
      requestedVisionBackend: "openai_api",
      resolvedVisionBackend: "openai_api",
      requestedVisionFallbackBackend: "disabled",
      resolvedVisionFallbackBackend: "disabled",
        requestedTranscriptionBackend: "openai_api",
        resolvedTranscriptionBackend: "openai_api",
        openAIApiKey: null,
        openAIBaseUrl: "https://api.openai.com/v1",
        ollamaApiKey: null,
        ollamaBaseUrl: "http://localhost:11434",
        visionModel: "gpt-4.1-mini",
        visionFallbackModel: null,
        transcriptionModel: "whisper-1",
        requestTimeoutMs: 45_000
    },
    {
      [computeMediaFixtureKey(imageBuffer)]: {
        summary: "Image fixture shows a failing save dialog.",
        transcript: null,
        ocrText: "Save failed",
        confidence: 0.91,
        provenance: "fixture image summary",
        source: "fixture_catalog",
        entityHints: ["save", "dialog"]
      },
      [computeMediaFixtureKey(voiceBuffer)]: {
        summary: "Voice fixture asks to fix the failing save flow.",
        transcript: "Please fix the save flow before we ship.",
        ocrText: null,
        confidence: 0.95,
        provenance: "fixture voice summary",
        source: "fixture_catalog",
        entityHints: ["save", "ship"]
      }
    }
  );

  const enriched = await organ.interpretEnvelope(
    envelope,
    new Map<string, Buffer>([
      ["image-1", imageBuffer],
      ["voice-2", voiceBuffer]
    ])
  );

  assert.equal(enriched?.attachments.length, 2);
  assert.equal(enriched?.attachments[0]?.interpretation?.summary, "Image fixture shows a failing save dialog.");
  assert.equal(enriched?.attachments[1]?.interpretation?.transcript, "Please fix the save flow before we ship.");
});

test("interpretImageAttachment can use a local Ollama vision model without auth", async () => {
  const originalFetch = globalThis.fetch;
  let seenAuthorizationHeader: string | null = null;
  let seenUrl = "";
  try {
    globalThis.fetch = (async (input, init) => {
      seenUrl = typeof input === "string" ? input : input.toString();
      seenAuthorizationHeader = new Headers(init?.headers).get("Authorization");
      return new Response(
        JSON.stringify({
          message: {
            content: "Local Gemma summary."
          }
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }) as typeof fetch;

    const interpretation = await interpretImageAttachment(
      {
        requestedBackend: "ollama",
        resolvedBackend: "ollama",
        requestedVisionBackend: "ollama",
        resolvedVisionBackend: "ollama",
        requestedVisionFallbackBackend: "disabled",
        resolvedVisionFallbackBackend: "disabled",
        requestedTranscriptionBackend: "disabled",
        resolvedTranscriptionBackend: "disabled",
        openAIApiKey: null,
        openAIBaseUrl: "https://api.openai.com/v1",
        ollamaApiKey: null,
        ollamaBaseUrl: "http://localhost:11434",
        visionModel: "gemma4-local",
        visionFallbackModel: null,
        transcriptionModel: "whisper-1",
        requestTimeoutMs: 45_000
      },
      {
        kind: "image",
        provider: "telegram",
        fileId: "image-ollama-1",
        fileUniqueId: "image-ollama-1",
        mimeType: "image/png",
        fileName: "dashboard.png",
        sizeBytes: 1024,
        caption: null,
        durationSeconds: null,
        width: 1280,
        height: 720
      },
      Buffer.from("png-data", "utf8")
    );

    assert.equal(seenUrl, "http://localhost:11434/api/chat");
    assert.equal(seenAuthorizationHeader, null);
    assert.equal(interpretation.summary, "Local Gemma summary.");
    assert.equal(interpretation.source, "ollama_image");
    assert.match(interpretation.provenance, /Ollama local model image summary model gemma4-local/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("interpretImageAttachment falls back to the configured OpenAI vision backend when Ollama vision fails", async () => {
  const originalFetch = globalThis.fetch;
  const seenUrls: string[] = [];
  try {
    globalThis.fetch = (async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      seenUrls.push(url);
      if (url === "http://localhost:11434/api/chat") {
        return new Response(
          JSON.stringify({
            error: "model failed to load"
          }),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
      }
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            summary: "The image shows the AgentBigBrain logo as a cartoon brain in a glass sphere.",
            ocr_text: "AgentBigBrain",
            entity_hints: ["AgentBigBrain"]
          })
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }) as typeof fetch;

    const interpretation = await interpretImageAttachment(
      {
        requestedBackend: "ollama",
        resolvedBackend: "ollama",
        requestedVisionBackend: "ollama",
        resolvedVisionBackend: "ollama",
        requestedVisionFallbackBackend: "openai_api",
        resolvedVisionFallbackBackend: "openai_api",
        requestedTranscriptionBackend: "disabled",
        resolvedTranscriptionBackend: "disabled",
        openAIApiKey: "sk-test",
        openAIBaseUrl: "https://api.openai.com/v1",
        ollamaApiKey: null,
        ollamaBaseUrl: "http://localhost:11434",
        visionModel: "gemma4-local",
        visionFallbackModel: "gpt-4.1-mini",
        transcriptionModel: "whisper-1",
        requestTimeoutMs: 45_000
      },
      {
        kind: "image",
        provider: "telegram",
        fileId: "image-fallback-1",
        fileUniqueId: "image-fallback-1",
        mimeType: "image/png",
        fileName: "AgentBigBrain.png",
        sizeBytes: 1024,
        caption: null,
        durationSeconds: null,
        width: 1280,
        height: 720
      },
      Buffer.from("png-data", "utf8")
    );

    assert.deepEqual(seenUrls, [
      "http://localhost:11434/api/chat",
      "https://api.openai.com/v1/responses"
    ]);
    assert.equal(interpretation.source, "openai_image");
    assert.match(interpretation.summary, /AgentBigBrain logo/i);
    assert.equal(interpretation.ocrText, "AgentBigBrain");
    assert.deepEqual(interpretation.entityHints, ["AgentBigBrain"]);
    assert.match(interpretation.provenance, /OpenAI image summary model gpt-4\.1-mini/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("interpretImageAttachment parses structured OCR and filters low-signal entity hints", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({
        message: {
          content: JSON.stringify({
            summary: "The image shows an approval-flow diagram for AgentBigBrain.",
            ocr_text: "AgentBigBrain Approval Flow",
            entity_hints: ["AgentBigBrain", "Approval Flow", "Please"]
          })
        }
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      }
    )) as typeof fetch;

    const interpretation = await interpretImageAttachment(
      {
        requestedBackend: "ollama",
        resolvedBackend: "ollama",
        requestedVisionBackend: "ollama",
        resolvedVisionBackend: "ollama",
        requestedVisionFallbackBackend: "disabled",
        resolvedVisionFallbackBackend: "disabled",
        requestedTranscriptionBackend: "disabled",
        resolvedTranscriptionBackend: "disabled",
        openAIApiKey: null,
        openAIBaseUrl: "https://api.openai.com/v1",
        ollamaApiKey: null,
        ollamaBaseUrl: "http://localhost:11434",
        visionModel: "gemma4-local",
        visionFallbackModel: null,
        transcriptionModel: "whisper-1",
        requestTimeoutMs: 45_000
      },
      {
        kind: "image",
        provider: "telegram",
        fileId: "image-structured-1",
        fileUniqueId: "image-structured-1",
        mimeType: "image/png",
        fileName: "approval-flow.png",
        sizeBytes: 1024,
        caption: "Review this diagram.",
        durationSeconds: null,
        width: 1280,
        height: 720
      },
      Buffer.from("png-data", "utf8")
    );

    assert.equal(interpretation.summary, "The image shows an approval-flow diagram for AgentBigBrain.");
    assert.equal(interpretation.ocrText, "AgentBigBrain Approval Flow");
    assert.deepEqual(
      interpretation.entityHints,
      ["AgentBigBrain", "Approval Flow"]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("interpretDocumentAttachment extracts readable text and identifiers from a synthetic PDF", async () => {
  const pdfBuffer = buildTextPdfBuffer([
    "Sample Business Filing",
    "Legal entity name: ACME SAMPLE DESIGN, LLC",
    "Registration identifier: 123456789",
    "Requested trade label: SAMPLE TRADE NAME"
  ]);

  const interpretation = await interpretDocumentAttachment(
    {
      requestedBackend: "inherit_text_backend",
      resolvedBackend: "mock",
      requestedVisionBackend: "inherit_text_backend",
      resolvedVisionBackend: "mock",
      requestedVisionFallbackBackend: "disabled",
      resolvedVisionFallbackBackend: "disabled",
      requestedTranscriptionBackend: "inherit_text_backend",
      resolvedTranscriptionBackend: "mock",
      openAIApiKey: null,
      openAIBaseUrl: "https://api.openai.com/v1",
      ollamaApiKey: null,
      ollamaBaseUrl: "http://localhost:11434",
      visionModel: "gpt-4.1-mini",
      visionFallbackModel: null,
      transcriptionModel: "whisper-1",
      requestTimeoutMs: 45_000
    },
    {
      kind: "document",
      provider: "telegram",
      fileId: "document-pdf-1",
      fileUniqueId: "document-pdf-1",
      mimeType: "application/pdf",
      fileName: "sample-business-filing.pdf",
      sizeBytes: pdfBuffer.length,
      caption: "Please review the attached PDF.",
      durationSeconds: null,
      width: null,
      height: null
    },
    pdfBuffer
  );

  assert.match(interpretation.summary, /readable extracted text/i);
  assert.match(interpretation.summary, /123456789/);
  assert.match(interpretation.ocrText ?? "", /ACME SAMPLE DESIGN, LLC/i);
  assert.match(interpretation.ocrText ?? "", /SAMPLE TRADE NAME/i);
  assert.match(interpretation.ocrText ?? "", /123456789/);
  assert.ok(interpretation.entityHints.some((hint) => /ACME SAMPLE DESIGN/i.test(hint)));
  assert.equal(interpretation.source, "document_text_extraction");
});

/**
 * Builds a minimal single-page PDF fixture with deterministic text content.
 *
 * **Why it exists:**
 * CI cannot rely on local temp-probe files, so the document extraction test needs a generated
 * fixture that still exercises the PDF parser path.
 *
 * **What it talks to:**
 * - Uses local string and buffer construction only.
 *
 * @param lines - Text lines to draw into the PDF page.
 * @returns PDF bytes suitable for pdfjs text extraction.
 */
function buildTextPdfBuffer(lines: readonly string[]): Buffer {
  const textCommands = lines
    .map((line, index) => `${index === 0 ? "" : "T* "}/F1 12 Tf (${escapePdfText(line)}) Tj`)
    .join("\n");
  const stream = [
    "BT",
    "72 720 Td",
    "14 TL",
    textCommands,
    "ET"
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`
  ];
  const chunks = ["%PDF-1.4\n"];
  const offsets: number[] = [0];
  let byteOffset = Buffer.byteLength(chunks[0], "utf8");

  for (const [index, objectBody] of objects.entries()) {
    offsets.push(byteOffset);
    const object = `${index + 1} 0 obj\n${objectBody}\nendobj\n`;
    chunks.push(object);
    byteOffset += Buffer.byteLength(object, "utf8");
  }

  const xrefOffset = byteOffset;
  const xrefLines = [
    "xref",
    `0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.slice(1).map((offset) => `${offset.toString().padStart(10, "0")} 00000 n `),
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    `${xrefOffset}`,
    "%%EOF"
  ];
  chunks.push(`${xrefLines.join("\n")}\n`);
  return Buffer.from(chunks.join(""), "utf8");
}

/**
 * Escapes literal text for a PDF string object.
 *
 * **Why it exists:**
 * PDF literal strings reserve backslashes and parentheses, and the test fixture builder must keep
 * generated bytes valid for arbitrary line text.
 *
 * **What it talks to:**
 * - Uses local string replacement only.
 *
 * @param value - Unescaped text line.
 * @returns Escaped PDF literal string content.
 */
function escapePdfText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

test("interpretVoiceAttachment can use multimodal audio models on a local OpenAI-compatible endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let seenAuthorizationHeader: string | null = null;
  let seenUrl = "";
  let seenBody = "";
  try {
    globalThis.fetch = (async (input, init) => {
      seenUrl = typeof input === "string" ? input : input.toString();
      seenAuthorizationHeader = new Headers(init?.headers).get("Authorization");
      seenBody = typeof init?.body === "string" ? init.body : "";
      return new Response(
        JSON.stringify({
          output_text: "Please swing by after lunch."
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }) as typeof fetch;

    const interpretation = await interpretVoiceAttachment(
      {
        requestedBackend: "openai_api",
        resolvedBackend: "openai_api",
        requestedVisionBackend: "disabled",
        resolvedVisionBackend: "disabled",
        requestedVisionFallbackBackend: "disabled",
        resolvedVisionFallbackBackend: "disabled",
        requestedTranscriptionBackend: "openai_api",
        resolvedTranscriptionBackend: "openai_api",
        openAIApiKey: null,
        openAIBaseUrl: "http://127.0.0.1:8080/v1",
        ollamaApiKey: null,
        ollamaBaseUrl: "http://localhost:11434",
        visionModel: "gpt-4.1-mini",
        visionFallbackModel: null,
        transcriptionModel: "google/gemma-4-E4B-it",
        requestTimeoutMs: 45_000
      },
      {
        kind: "voice",
        provider: "telegram",
        fileId: "voice-gemma-1",
        fileUniqueId: "voice-gemma-1",
        mimeType: "audio/ogg",
        fileName: "voice-note.ogg",
        sizeBytes: 1024,
        caption: null,
        durationSeconds: 8,
        width: null,
        height: null
      },
      Buffer.from("voice-data", "utf8")
    );

    assert.equal(seenUrl, "http://127.0.0.1:8080/v1/responses");
    assert.equal(seenAuthorizationHeader, null);
    assert.match(seenBody, /input_audio/);
    assert.match(seenBody, /google\/gemma-4-E4B-it/);
    assert.equal(interpretation.transcript, "Please swing by after lunch.");
    assert.equal(interpretation.source, "multimodal_audio");
    assert.match(interpretation.provenance, /OpenAI-compatible local model transcription model google\/gemma-4-E4B-it/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("interpretVoiceAttachment can use multimodal Gemma audio through Ollama's local compatibility endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let seenAuthorizationHeader: string | null = null;
  let seenUrl = "";
  let seenBody = "";
  try {
    globalThis.fetch = (async (input, init) => {
      seenUrl = typeof input === "string" ? input : input.toString();
      seenAuthorizationHeader = new Headers(init?.headers).get("Authorization");
      seenBody = typeof init?.body === "string" ? init.body : "";
      return new Response(
        JSON.stringify({
          output_text: "Call Billy after lunch."
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }) as typeof fetch;

    const interpretation = await interpretVoiceAttachment(
      {
        requestedBackend: "ollama",
        resolvedBackend: "ollama",
        requestedVisionBackend: "disabled",
        resolvedVisionBackend: "disabled",
        requestedVisionFallbackBackend: "disabled",
        resolvedVisionFallbackBackend: "disabled",
        requestedTranscriptionBackend: "ollama",
        resolvedTranscriptionBackend: "ollama",
        openAIApiKey: null,
        openAIBaseUrl: "https://api.openai.com/v1",
        ollamaApiKey: null,
        ollamaBaseUrl: "http://localhost:11434",
        visionModel: "gemma4:latest",
        visionFallbackModel: null,
        transcriptionModel: "gemma4:latest",
        requestTimeoutMs: 45_000
      },
      {
        kind: "voice",
        provider: "telegram",
        fileId: "voice-gemma-ollama-1",
        fileUniqueId: "voice-gemma-ollama-1",
        mimeType: "audio/ogg",
        fileName: "voice-note.ogg",
        sizeBytes: 1024,
        caption: null,
        durationSeconds: 8,
        width: null,
        height: null
      },
      Buffer.from("voice-data", "utf8")
    );

    assert.equal(seenUrl, "http://localhost:11434/v1/responses");
    assert.equal(seenAuthorizationHeader, null);
    assert.match(seenBody, /input_audio/);
    assert.match(seenBody, /gemma4:latest/);
    assert.equal(interpretation.transcript, "Call Billy after lunch.");
    assert.equal(interpretation.source, "multimodal_audio");
    assert.match(interpretation.provenance, /Ollama local model transcription model gemma4:latest/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
