/**
 * @fileoverview Covers canonical media-only input normalization, including voice command promotion.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildConversationInboundUserInput } from "../../src/interfaces/mediaRuntime/mediaNormalization";

test("buildConversationInboundUserInput promotes explicit voice command transcripts into slash commands", () => {
  const input = buildConversationInboundUserInput("", {
    attachments: [
      {
        kind: "voice",
        provider: "telegram",
        fileId: "voice-1",
        fileUniqueId: "voice-1-uniq",
        mimeType: "audio/ogg",
        fileName: null,
        sizeBytes: 1024,
        caption: null,
        durationSeconds: 8,
        width: null,
        height: null,
        interpretation: {
          summary: "Voice note asking for autonomous execution.",
          transcript: "BigBrain, command auto fix the planner test now",
          ocrText: null,
          confidence: 0.94,
          provenance: "transcription",
          source: "fixture_catalog",
          entityHints: ["planner"]
        }
      }
    ]
  });

  assert.equal(input, "/auto fix the planner test now");
});

test("buildConversationInboundUserInput keeps ordinary voice transcripts conversational", () => {
  const input = buildConversationInboundUserInput("", {
    attachments: [
      {
        kind: "voice",
        provider: "telegram",
        fileId: "voice-2",
        fileUniqueId: "voice-2-uniq",
        mimeType: "audio/ogg",
        fileName: null,
        sizeBytes: 1024,
        caption: null,
        durationSeconds: 8,
        width: null,
        height: null,
        interpretation: {
          summary: "Voice note asking for a planner fix.",
          transcript: "Please fix the planner test now.",
          ocrText: null,
          confidence: 0.94,
          provenance: "transcription",
          source: "fixture_catalog",
          entityHints: ["planner"]
        }
      }
    ]
  });

  assert.equal(input, "Voice note transcript: Please fix the planner test now.");
});

test("buildConversationInboundUserInput does not let voice command promotion override explicit text", () => {
  const input = buildConversationInboundUserInput("please use this voice note as extra context", {
    attachments: [
      {
        kind: "voice",
        provider: "telegram",
        fileId: "voice-3",
        fileUniqueId: "voice-3-uniq",
        mimeType: "audio/ogg",
        fileName: null,
        sizeBytes: 1024,
        caption: null,
        durationSeconds: 8,
        width: null,
        height: null,
        interpretation: {
          summary: "Voice note asking for status.",
          transcript: "command status",
          ocrText: null,
          confidence: 0.94,
          provenance: "transcription",
          source: "fixture_catalog",
          entityHints: []
        }
      }
    ]
  });

  assert.match(input, /^please use this voice note as extra context/i);
  assert.match(input, /Attached media context:/);
  assert.doesNotMatch(input, /^\/status$/);
});

test("buildConversationInboundUserInput leaves unknown voice commands as normal transcripts", () => {
  const input = buildConversationInboundUserInput("", {
    attachments: [
      {
        kind: "voice",
        provider: "telegram",
        fileId: "voice-4",
        fileUniqueId: "voice-4-uniq",
        mimeType: "audio/ogg",
        fileName: null,
        sizeBytes: 1024,
        caption: null,
        durationSeconds: 8,
        width: null,
        height: null,
        interpretation: {
          summary: "Voice note with an unknown command token.",
          transcript: "command launch the spaceship",
          ocrText: null,
          confidence: 0.94,
          provenance: "transcription",
          source: "fixture_catalog",
          entityHints: []
        }
      }
    ]
  });

  assert.equal(input, "Voice note transcript: command launch the spaceship");
});

test("buildConversationInboundUserInput only promotes voice commands near the start of the transcript", () => {
  const input = buildConversationInboundUserInput("", {
    attachments: [
      {
        kind: "voice",
        provider: "telegram",
        fileId: "voice-5",
        fileUniqueId: "voice-5-uniq",
        mimeType: "audio/ogg",
        fileName: null,
        sizeBytes: 1024,
        caption: null,
        durationSeconds: 8,
        width: null,
        height: null,
        interpretation: {
          summary: "Voice note that mentions command words later in the sentence.",
          transcript: "Please listen first and then command auto fix the planner test now.",
          ocrText: null,
          confidence: 0.94,
          provenance: "transcription",
          source: "fixture_catalog",
          entityHints: ["planner"]
        }
      }
    ]
  });

  assert.equal(
    input,
    "Voice note transcript: Please listen first and then command auto fix the planner test now."
  );
});
