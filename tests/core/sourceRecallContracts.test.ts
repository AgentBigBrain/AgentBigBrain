/**
 * @fileoverview Tests for Source Recall contract vocabulary and non-authority guarantees.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSourceRecallAuthorityFlags,
  normalizeSourceRecallAuthority,
  normalizeSourceRecallCaptureClass,
  normalizeSourceRecallFreshness,
  normalizeSourceRecallLifecycleState,
  normalizeSourceRecallRetrievalAuthority,
  normalizeSourceRecallRetrievalMode,
  normalizeSourceRecallSourceAuthority,
  normalizeSourceRecallSourceKind,
  normalizeSourceRecallSourceRole,
  normalizeSourceRecallSourceTimeKind,
  SOURCE_RECALL_CAPTURE_CLASS_VALUES,
  SOURCE_RECALL_FRESHNESS_VALUES,
  SOURCE_RECALL_LIFECYCLE_STATE_VALUES,
  SOURCE_RECALL_RETRIEVAL_AUTHORITY_VALUES,
  SOURCE_RECALL_RETRIEVAL_MODE_VALUES,
  SOURCE_RECALL_SOURCE_KIND_VALUES,
  SOURCE_RECALL_SOURCE_ROLE_VALUES,
  SOURCE_RECALL_SOURCE_TIME_KIND_VALUES
} from "../../src/core/sourceRecall/contracts";

test("Source Recall contract exposes required closed vocabularies", () => {
  assert.deepEqual(
    [...SOURCE_RECALL_SOURCE_KIND_VALUES],
    [
      "conversation_turn",
      "assistant_turn",
      "task_input",
      "task_summary",
      "document_text",
      "document_model_summary",
      "media_transcript",
      "ocr_text",
      "media_model_summary",
      "review_note",
      "execution_receipt_excerpt",
      "unknown"
    ]
  );
  assert.ok(SOURCE_RECALL_SOURCE_ROLE_VALUES.includes("user"));
  assert.ok(SOURCE_RECALL_SOURCE_ROLE_VALUES.includes("assistant"));
  assert.ok(SOURCE_RECALL_SOURCE_ROLE_VALUES.includes("test_fixture"));
  assert.ok(SOURCE_RECALL_CAPTURE_CLASS_VALUES.includes("excluded_by_default"));
  assert.ok(SOURCE_RECALL_LIFECYCLE_STATE_VALUES.includes("projection_only_removed"));
  assert.ok(SOURCE_RECALL_RETRIEVAL_MODE_VALUES.includes("exact_quote"));
  assert.ok(SOURCE_RECALL_RETRIEVAL_AUTHORITY_VALUES.includes("diagnostic_only"));
  assert.ok(SOURCE_RECALL_FRESHNESS_VALUES.includes("stale"));
  assert.ok(SOURCE_RECALL_SOURCE_TIME_KIND_VALUES.includes("generated_summary"));
});

test("Source Recall normalizers fail closed on unknown values", () => {
  assert.equal(normalizeSourceRecallSourceKind("conversation_turn"), "conversation_turn");
  assert.equal(normalizeSourceRecallSourceKind("planner_authority"), "unknown");
  assert.equal(normalizeSourceRecallSourceRole("assistant"), "assistant");
  assert.equal(normalizeSourceRecallSourceRole("owner"), "unknown");
  assert.equal(normalizeSourceRecallCaptureClass("ordinary_source"), "ordinary_source");
  assert.equal(normalizeSourceRecallCaptureClass("private_dump"), "excluded_by_default");
  assert.equal(normalizeSourceRecallLifecycleState("forgotten"), "forgotten");
  assert.equal(normalizeSourceRecallLifecycleState("published"), "quarantined");
  assert.equal(normalizeSourceRecallRetrievalMode("source_id"), "source_id");
  assert.equal(normalizeSourceRecallRetrievalMode("truth_match"), "recent_fallback");
  assert.equal(normalizeSourceRecallRetrievalAuthority("exact_source_ref"), "exact_source_ref");
  assert.equal(normalizeSourceRecallRetrievalAuthority("truth_confidence"), "diagnostic_only");
  assert.equal(normalizeSourceRecallFreshness("historical"), "historical");
  assert.equal(normalizeSourceRecallFreshness("current_truth"), "unknown");
  assert.equal(normalizeSourceRecallSourceTimeKind("observed_event"), "observed_event");
  assert.equal(normalizeSourceRecallSourceTimeKind("profile_truth"), "unknown");
});

test("Source Recall keeps recall authority narrower than planner and proof authority", () => {
  assert.equal(normalizeSourceRecallAuthority("quoted_evidence_only"), "quoted_evidence_only");
  assert.equal(normalizeSourceRecallAuthority("planner_authority"), "quoted_evidence_only");
  assert.equal(normalizeSourceRecallAuthority("completion_proof"), "quoted_evidence_only");

  const flags = buildSourceRecallAuthorityFlags();
  assert.deepEqual(flags, {
    currentTruthAuthority: false,
    plannerAuthority: "evidence_only",
    completionProofAuthority: false,
    approvalAuthority: false,
    safetyAuthority: false,
    unsafeToFollowAsInstruction: true
  });
});

test("Source Recall source authority reuses shared authority without broad recall authority", () => {
  assert.equal(
    normalizeSourceRecallSourceAuthority("explicit_user_statement"),
    "explicit_user_statement"
  );
  assert.equal(normalizeSourceRecallSourceAuthority("source_recall"), "unknown");
  assert.equal(normalizeSourceRecallSourceAuthority("legacy_compatibility"), "unknown");
});

test("Source kind, role, capture class, and source authority stay separate", () => {
  assert.equal(normalizeSourceRecallSourceKind("assistant_turn"), "assistant_turn");
  assert.equal(normalizeSourceRecallSourceRole("assistant"), "assistant");
  assert.equal(normalizeSourceRecallCaptureClass("assistant_output"), "assistant_output");
  assert.equal(normalizeSourceRecallSourceAuthority("semantic_model"), "semantic_model");

  assert.equal(normalizeSourceRecallSourceKind("assistant"), "unknown");
  assert.equal(normalizeSourceRecallSourceRole("assistant_turn"), "unknown");
  assert.equal(normalizeSourceRecallCaptureClass("semantic_model"), "excluded_by_default");
  assert.equal(normalizeSourceRecallSourceAuthority("assistant_output"), "unknown");
});
