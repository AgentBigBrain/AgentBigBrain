/**
 * @fileoverview Focused tests for profile-memory ingest source-lane policy.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildProfileMemoryIngestPolicy,
  classifyProfileMemoryIngestSourceFamily,
  getProfileMemoryIngestSourceDefaultAuthority,
  selectProfileMemoryExtractionStages
} from "../../src/core/profileMemoryRuntime/profileMemoryIngestPolicy";

test("ingest source lanes map document and media fragments to candidate-only authority", () => {
  assert.equal(classifyProfileMemoryIngestSourceFamily("document_text"), "document_text_extraction");
  assert.equal(classifyProfileMemoryIngestSourceFamily("document_summary"), "document_model_summary");
  assert.equal(classifyProfileMemoryIngestSourceFamily("image_summary"), "media_model_summary");
  assert.equal(getProfileMemoryIngestSourceDefaultAuthority("document_summary"), "candidate_only");
});

test("document and media source lanes disable durable extraction before truth governance", () => {
  const policy = buildProfileMemoryIngestPolicy({
    memoryIntent: "profile_update",
    sourceSurface: "conversation_profile_input",
    sourceLane: "document_summary"
  });
  const stages = selectProfileMemoryExtractionStages(policy);

  assert.equal(policy.fragmentPolicy, "candidate_only");
  assert.equal(stages.exactSelfFacts, false);
  assert.equal(stages.directRelationshipFacts, false);
  assert.equal(stages.episodeSupport, false);
});

test("voice transcript source lanes stay support-only unless a later review promotes them", () => {
  const policy = buildProfileMemoryIngestPolicy({
    memoryIntent: "relationship_recall",
    sourceSurface: "conversation_profile_input",
    sourceLane: "voice_transcript"
  });
  const stages = selectProfileMemoryExtractionStages(policy);

  assert.equal(policy.fragmentPolicy, "support_only");
  assert.equal(stages.exactSelfFacts, false);
  assert.equal(stages.directRelationshipFacts, false);
  assert.equal(stages.episodeSupport, true);
});
