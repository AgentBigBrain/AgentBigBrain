/**
 * @fileoverview Verifies bounded media-understanding helpers and deterministic fixture interpretation.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ConversationInboundMediaEnvelope } from "../../src/interfaces/mediaRuntime/contracts";
import { createMediaUnderstandingConfigFromEnv } from "../../src/organs/mediaUnderstanding/contracts";
import {
  computeMediaFixtureKey,
  interpretMediaAttachment,
  MediaUnderstandingOrgan
} from "../../src/organs/mediaUnderstanding/mediaInterpretation";

test("createMediaUnderstandingConfigFromEnv falls back to bounded defaults", () => {
  const originalEnv = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    BRAIN_MEDIA_VISION_MODEL: process.env.BRAIN_MEDIA_VISION_MODEL,
    BRAIN_MEDIA_TRANSCRIPTION_MODEL: process.env.BRAIN_MEDIA_TRANSCRIPTION_MODEL,
    BRAIN_MEDIA_REQUEST_TIMEOUT_MS: process.env.BRAIN_MEDIA_REQUEST_TIMEOUT_MS
  };

  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.BRAIN_MEDIA_VISION_MODEL;
  delete process.env.BRAIN_MEDIA_TRANSCRIPTION_MODEL;
  delete process.env.BRAIN_MEDIA_REQUEST_TIMEOUT_MS;

  try {
    const config = createMediaUnderstandingConfigFromEnv();
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
      openAIApiKey: null,
      openAIBaseUrl: "https://api.openai.com/v1",
      visionModel: "gpt-4.1-mini",
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
      openAIApiKey: null,
      openAIBaseUrl: "https://api.openai.com/v1",
      visionModel: "gpt-4.1-mini",
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
