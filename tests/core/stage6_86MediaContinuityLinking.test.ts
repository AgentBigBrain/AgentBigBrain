/**
 * @fileoverview Tests bounded continuity hint extraction from interpreted inbound media.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildMediaContinuityHints } from "../../src/core/stage6_86/mediaContinuityLinking";

test("buildMediaContinuityHints returns bounded hints from image, voice, and video interpretations", () => {
  const hints = buildMediaContinuityHints({
    attachments: [
      {
        kind: "image",
        provider: "telegram",
        fileId: "image-1",
        fileUniqueId: "image-uniq-1",
        mimeType: "image/png",
        fileName: "planner.png",
        sizeBytes: 1024,
        caption: "This screenshot shows Owen near the MRI calendar.",
        durationSeconds: null,
        width: 1280,
        height: 720,
        interpretation: {
          summary: "Screenshot shows Owen and the MRI follow-up note in the planner.",
          transcript: null,
          ocrText: "Owen MRI results follow-up",
          confidence: 0.92,
          provenance: "fixture image summary",
          source: "fixture_catalog",
          entityHints: ["Owen", "MRI"]
        }
      },
      {
        kind: "voice",
        provider: "telegram",
        fileId: "voice-1",
        fileUniqueId: "voice-uniq-1",
        mimeType: "audio/ogg",
        fileName: null,
        sizeBytes: 2048,
        caption: null,
        durationSeconds: 15,
        width: null,
        height: null,
        interpretation: {
          summary: "Voice note says Owen still has not heard about the MRI results.",
          transcript: "Owen still has not heard about the MRI results and I want to follow up.",
          ocrText: null,
          confidence: 0.95,
          provenance: "fixture voice summary",
          source: "fixture_catalog",
          entityHints: ["Owen", "follow-up"]
        }
      },
      {
        kind: "video",
        provider: "telegram",
        fileId: "video-1",
        fileUniqueId: "video-uniq-1",
        mimeType: "video/mp4",
        fileName: "clip.mp4",
        sizeBytes: 4096,
        caption: "The clip shows the wrong panel opening.",
        durationSeconds: 8,
        width: 1280,
        height: 720,
        interpretation: {
          summary: "Short video shows the wrong panel sliding in after the menu opens.",
          transcript: null,
          ocrText: "Settings panel",
          confidence: 0.81,
          provenance: "fixture video summary",
          source: "fixture_catalog",
          entityHints: ["panel", "menu"]
        }
      }
    ]
  });

  assert.ok(hints.recallHints.includes("owen"));
  assert.ok(hints.recallHints.includes("mri"));
  assert.ok(hints.recallHints.includes("panel"));
  assert.ok(hints.evidence.includes("entity_hints"));
  assert.ok(hints.evidence.includes("summary"));
  assert.ok(hints.evidence.includes("ocr"));
  assert.ok(hints.evidence.includes("caption"));
  assert.equal(hints.recallHints.length <= 8, true);
});

test("buildMediaContinuityHints returns empty cues when no media is attached", () => {
  const hints = buildMediaContinuityHints(null);
  assert.deepEqual(hints, {
    recallHints: [],
    evidence: []
  });
});
