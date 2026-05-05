/**
 * @fileoverview Tests for Source Recall retention and production disablement policy.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSourceRecallCaptureFailureDiagnostic,
  createDefaultSourceRecallRetentionPolicy,
  createSourceRecallRuntimeConfigFromEnv,
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
    "source_recall_disabled",
    "source_recall_capture_disabled",
    "source_recall_encryption_unavailable",
    "source_recall_source_kind_not_allowed",
    "source_recall_capture_class_not_allowed"
  ]);
});

test("Source Recall capture requires encryption readiness when production capture is enabled", () => {
  const blockedPolicy = createSourceRecallRetentionPolicyFromEnv({
    BRAIN_SOURCE_RECALL_ENABLED: "true",
    BRAIN_SOURCE_RECALL_CAPTURE_SOURCE_KINDS: "conversation_turn",
    BRAIN_SOURCE_RECALL_CAPTURE_CLASSES: "ordinary_source",
    BRAIN_SOURCE_RECALL_CAPTURE_ENABLED: "true"
  });
  const spoofedEnvPolicy = createSourceRecallRetentionPolicyFromEnv({
    BRAIN_SOURCE_RECALL_ENABLED: "true",
    BRAIN_SOURCE_RECALL_CAPTURE_ENABLED: "true",
    BRAIN_SOURCE_RECALL_ENCRYPTED_PAYLOADS_AVAILABLE: "true",
    BRAIN_SOURCE_RECALL_CAPTURE_SOURCE_KINDS: "conversation_turn",
    BRAIN_SOURCE_RECALL_CAPTURE_CLASSES: "ordinary_source"
  });
  const allowedPolicy = createSourceRecallRetentionPolicyFromEnv(
    {
      BRAIN_SOURCE_RECALL_ENABLED: "true",
      BRAIN_SOURCE_RECALL_CAPTURE_SOURCE_KINDS: "conversation_turn",
      BRAIN_SOURCE_RECALL_CAPTURE_CLASSES: "ordinary_source",
      BRAIN_SOURCE_RECALL_CAPTURE_ENABLED: "true"
    },
    { encryptedPayloadsAvailable: true }
  );

  assert.deepEqual(
    decideSourceRecallCapture(blockedPolicy, {
      sourceKind: "conversation_turn",
      sourceRole: "user",
      captureClass: "ordinary_source"
    }).reasons,
    ["source_recall_encryption_unavailable"]
  );
  assert.deepEqual(
    decideSourceRecallCapture(spoofedEnvPolicy, {
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
    BRAIN_SOURCE_RECALL_ENABLED: "true",
    BRAIN_SOURCE_RECALL_CAPTURE_SOURCE_KINDS: "conversation_turn",
    BRAIN_SOURCE_RECALL_CAPTURE_CLASSES: "ordinary_source",
    BRAIN_SOURCE_RECALL_CAPTURE_ENABLED: "true"
  }, { encryptedPayloadsAvailable: true });
  const evidencePolicy = createSourceRecallRetentionPolicyFromEnv(
    {
      BRAIN_SOURCE_RECALL_ENABLED: "true",
      BRAIN_SOURCE_RECALL_CAPTURE_SOURCE_KINDS: "conversation_turn",
      BRAIN_SOURCE_RECALL_CAPTURE_CLASSES: "ordinary_source",
      BRAIN_SOURCE_RECALL_CAPTURE_ENABLED: "true",
      BRAIN_SOURCE_RECALL_EVIDENCE_MODE: "true"
    },
    { encryptedPayloadsAvailable: true }
  );

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
    BRAIN_SOURCE_RECALL_ENABLED: "true",
    BRAIN_SOURCE_RECALL_PROJECTION_ENABLED: "true"
  });
  const operatorFullPolicy = createSourceRecallRetentionPolicyFromEnv({
    BRAIN_SOURCE_RECALL_ENABLED: "true",
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

test("Source Recall runtime config defaults disabled and exposes concrete block reasons", () => {
  const defaultConfig = createSourceRecallRuntimeConfigFromEnv({});
  const missingEncryption = createSourceRecallRuntimeConfigFromEnv({
    BRAIN_SOURCE_RECALL_ENABLED: "true",
    BRAIN_SOURCE_RECALL_CAPTURE_ENABLED: "true",
    BRAIN_SOURCE_RECALL_CAPTURE_SOURCE_KINDS: "conversation_turn",
    BRAIN_SOURCE_RECALL_CAPTURE_CLASSES: "ordinary_source"
  });
  const enabled = createSourceRecallRuntimeConfigFromEnv({
    BRAIN_SOURCE_RECALL_ENABLED: "true",
    BRAIN_SOURCE_RECALL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64")
  });

  assert.equal(defaultConfig.status, "disabled");
  assert.deepEqual(defaultConfig.retentionPolicy.sourceKindCaptureAllowlist, []);
  assert.equal(missingEncryption.status, "blocked_missing_encryption");
  assert.deepEqual(missingEncryption.blockedReasons, ["source_recall_encryption_key_missing"]);
  assert.equal(enabled.status, "enabled");
  assert.equal(enabled.encryptionKeyConfigured, true);
});

test("Source Recall production allowlists accept explicit conversation assistant and task scope", () => {
  const policy = createSourceRecallRetentionPolicyFromEnv({
    BRAIN_SOURCE_RECALL_ENABLED: "true",
    BRAIN_SOURCE_RECALL_CAPTURE_ENABLED: "true",
    BRAIN_SOURCE_RECALL_CAPTURE_SOURCE_KINDS: "conversation_turn,assistant_turn,task_input,task_summary",
    BRAIN_SOURCE_RECALL_CAPTURE_CLASSES: "ordinary_source,assistant_output,operational_output"
  }, { encryptedPayloadsAvailable: true });

  assert.equal(
    decideSourceRecallCapture(policy, {
      sourceKind: "conversation_turn",
      sourceRole: "user",
      captureClass: "ordinary_source"
    }).allowed,
    true
  );
  assert.equal(
    decideSourceRecallCapture(policy, {
      sourceKind: "assistant_turn",
      sourceRole: "assistant",
      captureClass: "assistant_output"
    }).allowed,
    true
  );
  assert.equal(
    decideSourceRecallCapture(policy, {
      sourceKind: "task_summary",
      sourceRole: "runtime",
      captureClass: "operational_output"
    }).allowed,
    true
  );
});

test("Source Recall production allowlists fail closed on missing empty or broader values", () => {
  const missing = createSourceRecallRetentionPolicyFromEnv({
    BRAIN_SOURCE_RECALL_ENABLED: "true",
    BRAIN_SOURCE_RECALL_CAPTURE_ENABLED: "true"
  }, { encryptedPayloadsAvailable: true });
  const empty = createSourceRecallRetentionPolicyFromEnv({
    BRAIN_SOURCE_RECALL_ENABLED: "true",
    BRAIN_SOURCE_RECALL_CAPTURE_ENABLED: "true",
    BRAIN_SOURCE_RECALL_CAPTURE_SOURCE_KINDS: "",
    BRAIN_SOURCE_RECALL_CAPTURE_CLASSES: ""
  }, { encryptedPayloadsAvailable: true });
  const broaderSourceKind = createSourceRecallRetentionPolicyFromEnv({
    BRAIN_SOURCE_RECALL_ENABLED: "true",
    BRAIN_SOURCE_RECALL_CAPTURE_ENABLED: "true",
    BRAIN_SOURCE_RECALL_CAPTURE_SOURCE_KINDS: "conversation_turn,document_text",
    BRAIN_SOURCE_RECALL_CAPTURE_CLASSES: "ordinary_source"
  }, { encryptedPayloadsAvailable: true });
  const broaderCaptureClass = createSourceRecallRetentionPolicyFromEnv({
    BRAIN_SOURCE_RECALL_ENABLED: "true",
    BRAIN_SOURCE_RECALL_CAPTURE_ENABLED: "true",
    BRAIN_SOURCE_RECALL_CAPTURE_SOURCE_KINDS: "conversation_turn",
    BRAIN_SOURCE_RECALL_CAPTURE_CLASSES: "ordinary_source,external_output"
  }, { encryptedPayloadsAvailable: true });

  for (const policy of [missing, empty]) {
    assert.deepEqual(
      decideSourceRecallCapture(policy, {
        sourceKind: "conversation_turn",
        sourceRole: "user",
        captureClass: "ordinary_source"
      }).reasons,
      [
        "source_recall_source_kind_not_allowed",
        "source_recall_capture_class_not_allowed"
      ]
    );
  }
  assert.deepEqual(
    decideSourceRecallCapture(broaderSourceKind, {
      sourceKind: "conversation_turn",
      sourceRole: "user",
      captureClass: "ordinary_source"
    }).reasons,
    ["source_recall_source_kind_not_allowed"]
  );
  assert.deepEqual(
    decideSourceRecallCapture(broaderCaptureClass, {
      sourceKind: "conversation_turn",
      sourceRole: "user",
      captureClass: "ordinary_source"
    }).reasons,
    ["source_recall_capture_class_not_allowed"]
  );
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
