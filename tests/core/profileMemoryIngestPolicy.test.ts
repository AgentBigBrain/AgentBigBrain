/**
 * @fileoverview Focused tests for profile-memory ingest source-lane policy.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildProfileMemoryIngestPolicy,
  buildLegacyProfileMemoryIngestPolicy,
  classifyProfileMemoryIngestSourceFamily,
  getProfileMemoryIngestSourceDefaultAuthority,
  normalizeProfileMemorySourceAuthority,
  profileMemoryIngestSourceLaneToAuthority,
  selectProfileMemoryExtractionStages
} from "../../src/core/profileMemoryRuntime/profileMemoryIngestPolicy";

test("ingest source lanes map document and media fragments to candidate-only authority", () => {
  assert.equal(classifyProfileMemoryIngestSourceFamily("document_text"), "document_text_extraction");
  assert.equal(classifyProfileMemoryIngestSourceFamily("document_summary"), "document_model_summary");
  assert.equal(classifyProfileMemoryIngestSourceFamily("image_summary"), "media_model_summary");
  assert.equal(getProfileMemoryIngestSourceDefaultAuthority("document_summary"), "candidate_only");
  assert.equal(profileMemoryIngestSourceLaneToAuthority("document_text"), "document_text");
  assert.equal(profileMemoryIngestSourceLaneToAuthority("document_summary"), "document_model_summary");
  assert.equal(profileMemoryIngestSourceLaneToAuthority("voice_transcript"), "media_transcript");
  assert.equal(profileMemoryIngestSourceLaneToAuthority("validated_model_candidate"), "semantic_model");
});

test("source authority normalization fails closed outside explicit compatibility paths", () => {
  assert.equal(normalizeProfileMemorySourceAuthority(undefined), "unknown");
  assert.equal(normalizeProfileMemorySourceAuthority("not_real"), "unknown");
  assert.equal(normalizeProfileMemorySourceAuthority("legacy_compatibility"), "unknown");
  assert.equal(
    normalizeProfileMemorySourceAuthority("legacy_compatibility", {
      allowLegacyCompatibility: true
    }),
    "legacy_compatibility"
  );
});

test("document and media source lanes disable durable extraction before truth governance", () => {
  const policy = buildProfileMemoryIngestPolicy({
    memoryIntent: "profile_update",
    sourceSurface: "conversation_profile_input",
    sourceLane: "document_summary"
  });
  const stages = selectProfileMemoryExtractionStages(policy);

  assert.equal(policy.fragmentPolicy, "candidate_only");
  assert.equal(policy.sourceAuthority, "document_model_summary");
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
  assert.equal(policy.sourceAuthority, "media_transcript");
  assert.equal(stages.exactSelfFacts, false);
  assert.equal(stages.directRelationshipFacts, false);
  assert.equal(stages.episodeSupport, true);
});

test("legacy ingest policies expose compatibility authority explicitly", () => {
  const policy = buildLegacyProfileMemoryIngestPolicy();

  assert.equal(policy.policySource, "legacy_compatibility");
  assert.equal(policy.sourceAuthority, "legacy_compatibility");
});
