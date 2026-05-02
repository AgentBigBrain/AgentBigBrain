/**
 * @fileoverview Tests bounded conversation profile-memory write request construction.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildConversationProfileMemoryWriteRequest } from "../../src/interfaces/conversationRuntime/conversationProfileMemoryWrite";
import { buildConversationSessionFixture } from "../helpers/conversationFixtures";

test("conversation profile-memory writes route media-only turns through source-lane policy", () => {
  const request = buildConversationProfileMemoryWriteRequest({
    session: buildConversationSessionFixture(),
    receivedAt: "2026-05-02T01:00:00.000Z",
    userInput: "Please review the attached image and respond based on what it shows.",
    memoryIntent: "profile_update",
    media: {
      attachments: [
        {
          kind: "image",
          provider: "telegram",
          fileId: "file_1",
          fileUniqueId: "unique_1",
          mimeType: "image/png",
          fileName: "sample.png",
          sizeBytes: 100,
          caption: null,
          durationSeconds: null,
          width: 10,
          height: 10,
          interpretation: {
            summary: "An image summary that mentions a possible contact.",
            transcript: null,
            ocrText: "A possible contact name appears in the image.",
            confidence: 0.8,
            provenance: "test",
            source: "openai_image",
            entityHints: [],
            layers: [
              {
                kind: "raw_text_extraction",
                source: "openai_image",
                text: "A possible contact name appears in the image.",
                confidence: 0.8,
                provenance: "test",
                memoryAuthority: "candidate_only"
              }
            ]
          }
        }
      ]
    }
  });

  assert.equal(request.ingestPolicy?.sourceLane, "image_ocr");
  assert.equal(request.ingestPolicy?.fragmentPolicy, "candidate_only");
  assert.equal(request.ingestPolicy?.allowDirectRelationshipExtraction, false);
  assert.deepEqual(request.mediaIngest?.allNarrativeFragments, []);
  assert.deepEqual(
    request.mediaIngest?.candidateOnlyFragments,
    ["A possible contact name appears in the image."]
  );
});
