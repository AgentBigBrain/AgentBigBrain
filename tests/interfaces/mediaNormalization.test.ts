/**
 * @fileoverview Covers canonical media-only input normalization, including voice command promotion.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildConversationCommandRoutingInput,
  buildConversationInboundUserInput
} from "../../src/interfaces/mediaRuntime/mediaNormalization";

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

test("buildConversationInboundUserInput promotes explicit voice skills inventory commands", () => {
  const input = buildConversationInboundUserInput("", {
    attachments: [
      {
        kind: "voice",
        provider: "telegram",
        fileId: "voice-skills-1",
        fileUniqueId: "voice-skills-1-uniq",
        mimeType: "audio/ogg",
        fileName: null,
        sizeBytes: 1024,
        caption: null,
        durationSeconds: 6,
        width: null,
        height: null,
        interpretation: {
          summary: "Voice note asking for the current skill inventory.",
          transcript: "command skills",
          ocrText: null,
          confidence: 0.94,
          provenance: "transcription",
          source: "fixture_catalog",
          entityHints: []
        }
      }
    ]
  });

  assert.equal(input, "/skills");
});

test("buildConversationInboundUserInput promotes longer explicit voice skill commands near the start", () => {
  const input = buildConversationInboundUserInput("", {
    attachments: [
      {
        kind: "voice",
        provider: "telegram",
        fileId: "voice-skills-2",
        fileUniqueId: "voice-skills-2-uniq",
        mimeType: "audio/ogg",
        fileName: null,
        sizeBytes: 1024,
        caption: null,
        durationSeconds: 10,
        width: null,
        height: null,
        interpretation: {
          summary: "Voice note asking for the skill inventory with a longer natural follow-up.",
          transcript:
            "BigBrain, command skills and then tell me which reusable tools you already trust for planner failure work because I do not want to rediscover the same fix again.",
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
    "/skills and then tell me which reusable tools you already trust for planner failure work because I do not want to rediscover the same fix again."
  );
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

test("buildConversationCommandRoutingInput ignores OCR and document text for command routing", () => {
  const input = buildConversationCommandRoutingInput(
    "Please review the attached PDF and tell me what it contains.",
    {
      attachments: [
        {
          kind: "document",
          provider: "telegram",
          fileId: "doc-1",
          fileUniqueId: "doc-1-uniq",
          mimeType: "application/pdf",
          fileName: "filing.pdf",
          sizeBytes: 2048,
          caption: null,
          durationSeconds: null,
          width: null,
          height: null,
          interpretation: {
            summary: "Certificate filing.",
            transcript: null,
            ocrText: "Signed before a notary public in Wayne County.",
            confidence: 0.91,
            provenance: "document extraction",
            source: "fixture_catalog",
            entityHints: ["Wayne County"]
          }
        }
      ]
    }
  );

  assert.equal(
    input,
    "Please review the attached PDF and tell me what it contains."
  );
});

test("buildConversationCommandRoutingInput still promotes explicit voice commands for media-only turns", () => {
  const input = buildConversationCommandRoutingInput("", {
    attachments: [
      {
        kind: "voice",
        provider: "telegram",
        fileId: "voice-cmd-1",
        fileUniqueId: "voice-cmd-1-uniq",
        mimeType: "audio/ogg",
        fileName: null,
        sizeBytes: 1024,
        caption: null,
        durationSeconds: 5,
        width: null,
        height: null,
        interpretation: {
          summary: "Voice note asking for pulse status.",
          transcript: "command status",
          ocrText: null,
          confidence: 0.93,
          provenance: "transcription",
          source: "fixture_catalog",
          entityHints: []
        }
      }
    ]
  });

  assert.equal(input, "/status");
});
