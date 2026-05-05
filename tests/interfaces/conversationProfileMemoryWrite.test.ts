/**
 * @fileoverview Tests bounded conversation profile-memory write request construction.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildValidatedSemanticRelationshipFactCandidates
} from "../../src/core/profileMemoryRuntime/profileMemorySemanticRelationshipCandidates";
import {
  attachSourceRecallRefsToSemanticRelationshipCandidates,
  buildSourceRecallSourceRef
} from "../../src/core/sourceRecall/sourceRecallMemoryBridge";
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

test("conversation profile-memory writes carry Source Recall refs from semantic candidates as provenance only", () => {
  const sourceRef = buildSourceRecallSourceRef("source_record_conversation_candidate", "chunk_conversation_candidate");
  const validatedFactCandidates = buildValidatedSemanticRelationshipFactCandidates(
    attachSourceRecallRefsToSemanticRelationshipCandidates(
      [
        {
          subject: "current_user",
          objectDisplayName: "Riley",
          relationLabel: "colleague",
          lifecycle: "current",
          sourceFamily: "semantic_model",
          ambiguity: "none",
          evidenceSpan: {
            text: "Riley is helping me review the studio launch plan."
          },
          confidence: 0.91
        }
      ],
      [sourceRef]
    )
  );

  const request = buildConversationProfileMemoryWriteRequest({
    session: buildConversationSessionFixture(),
    receivedAt: "2026-05-05T20:15:00.000Z",
    userInput: "Riley is helping me review the studio launch plan.",
    memoryIntent: "profile_update",
    validatedFactCandidates
  });

  const provenanceRef = request.provenance?.sourceRecallRefs?.[0];
  assert.equal(provenanceRef?.sourceRecordId, "source_record_conversation_candidate");
  assert.equal(provenanceRef?.chunkId, "chunk_conversation_candidate");
  assert.equal(provenanceRef?.authority.currentTruthAuthority, false);
  assert.equal(provenanceRef?.authority.approvalAuthority, false);
  assert.equal(provenanceRef?.authority.safetyAuthority, false);
  assert.equal(provenanceRef?.authority.completionProofAuthority, false);
  assert.equal(request.ingestPolicy?.policySource, "structured_candidate");
});
