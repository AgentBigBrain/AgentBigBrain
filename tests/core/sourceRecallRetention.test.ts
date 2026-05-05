/**
 * @fileoverview Tests for Source Recall retention and production disablement policy.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSourceRecallCaptureFailureDiagnostic,
  createDefaultSourceRecallRetentionPolicy,
  createSourceRecallRetentionPolicyFromEnv,
  decideSourceRecallCapture,
  decideSourceRecallIndexing,
  decideSourceRecallProjection,
  decideSourceRecallRetrieval,
  isSourceRecallProductionRejectedCaptureClass,
  SOURCE_RECALL_PRODUCTION_REJECTED_CAPTURE_CLASSES
} from "../../src/core/sourceRecall/sourceRecallRetention";

test("Source Recall production defaults are disabled and fail closed", () => {
  const policy = createDefaultSourceRecallRetentionPolicy();

  assert.equal(decideSourceRecallRetrieval(policy).allowed, false);
  assert.equal(decideSourceRecallProjection(policy, "review_safe").allowed, false);
  assert.equal(decideSourceRecallProjection(policy, "operator_full").allowed, false);
  assert.equal(decideSourceRecallIndexing(policy).allowed, false);

  const capture = decideSourceRecallCapture(policy, {
    sourceKind: "conversation_turn",
    sourceRole: "user",
    captureClass: "ordinary_source"
  });
  assert.equal(capture.allowed, false);
  assert.deepEqual(capture.reasons, [
    "source_recall_capture_disabled",
    "source_recall_encryption_unavailable"
  ]);
});

test("Source Recall capture requires encryption readiness when production capture is enabled", () => {
  const blockedPolicy = createSourceRecallRetentionPolicyFromEnv({
    BRAIN_SOURCE_RECALL_CAPTURE_ENABLED: "true"
  });
  const allowedPolicy = createSourceRecallRetentionPolicyFromEnv({
    BRAIN_SOURCE_RECALL_CAPTURE_ENABLED: "true",
    BRAIN_SOURCE_RECALL_ENCRYPTED_PAYLOADS_AVAILABLE: "true"
  });

  assert.deepEqual(
    decideSourceRecallCapture(blockedPolicy, {
      sourceKind: "conversation_turn",
      sourceRole: "user",
      captureClass: "ordinary_source"
    }).reasons,
    ["source_recall_encryption_unavailable"]
  );
  assert.equal(
    decideSourceRecallCapture(allowedPolicy, {
      sourceKind: "conversation_turn",
      sourceRole: "user",
      captureClass: "ordinary_source"
    }).allowed,
    true
  );
});

test("Source Recall production capture rejects test fixture source role and class", () => {
  const productionPolicy = createSourceRecallRetentionPolicyFromEnv({
    BRAIN_SOURCE_RECALL_CAPTURE_ENABLED: "true",
    BRAIN_SOURCE_RECALL_ENCRYPTED_PAYLOADS_AVAILABLE: "true"
  });
  const evidencePolicy = createSourceRecallRetentionPolicyFromEnv({
    BRAIN_SOURCE_RECALL_CAPTURE_ENABLED: "true",
    BRAIN_SOURCE_RECALL_ENCRYPTED_PAYLOADS_AVAILABLE: "true",
    BRAIN_SOURCE_RECALL_EVIDENCE_MODE: "true"
  });

  assert.deepEqual(
    decideSourceRecallCapture(productionPolicy, {
      sourceKind: "conversation_turn",
      sourceRole: "test_fixture",
      captureClass: "test_fixture"
    }).reasons,
    [
      "source_recall_capture_class_not_allowed",
      "source_recall_test_fixture_rejected"
    ]
  );
  assert.deepEqual(
    decideSourceRecallCapture(evidencePolicy, {
      sourceKind: "conversation_turn",
      sourceRole: "test_fixture",
      captureClass: "test_fixture"
    }).reasons,
    ["source_recall_capture_class_not_allowed"]
  );
});

test("Source Recall operator-full projection requires its own explicit latch", () => {
  const reviewSafePolicy = createSourceRecallRetentionPolicyFromEnv({
    BRAIN_SOURCE_RECALL_PROJECTION_ENABLED: "true"
  });
  const operatorFullPolicy = createSourceRecallRetentionPolicyFromEnv({
    BRAIN_SOURCE_RECALL_PROJECTION_ENABLED: "true",
    BRAIN_SOURCE_RECALL_OPERATOR_FULL_PROJECTION_ENABLED: "true"
  });

  assert.equal(decideSourceRecallProjection(reviewSafePolicy, "review_safe").allowed, true);
  assert.deepEqual(
    decideSourceRecallProjection(reviewSafePolicy, "operator_full").reasons,
    ["source_recall_operator_full_projection_disabled"]
  );
  assert.equal(decideSourceRecallProjection(operatorFullPolicy, "operator_full").allowed, true);
});

test("Source Recall non-capture firewall names production-rejected capture classes", () => {
  for (const captureClass of SOURCE_RECALL_PRODUCTION_REJECTED_CAPTURE_CLASSES) {
    assert.equal(isSourceRecallProductionRejectedCaptureClass(captureClass), true);
  }
  assert.equal(isSourceRecallProductionRejectedCaptureClass("ordinary_source"), false);
});

test("Source Recall blocked capture diagnostics avoid raw source text", () => {
  const diagnostic = buildSourceRecallCaptureFailureDiagnostic(
    {
      sourceKind: "conversation_turn",
      sourceRole: "user",
      captureClass: "excluded_by_default"
    },
    "source_recall_capture_class_not_allowed",
    {
      originRefId: "origin_ref_123",
      sourceHashPrefix: "abc123"
    }
  );

  assert.deepEqual(diagnostic, {
    sourceKind: "conversation_turn",
    sourceRole: "user",
    captureClass: "excluded_by_default",
    errorCode: "source_recall_capture_class_not_allowed",
    originRefId: "origin_ref_123",
    sourceHashPrefix: "abc123"
  });
  assert.equal("rawSourceText" in diagnostic, false);
});
