/**
 * @fileoverview Tests Dynamic Pulse semantic inquiry evidence matrix behavior.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  loadDynamicPulseSemanticInquiryScenarios,
  runDynamicPulseSemanticInquiryMatrix
} from "../../scripts/evidence/dynamicPulseSemanticInquiryMatrix";

const REQUIRED_SCENARIO_IDS = [
  "day1_user_requested_followup",
  "stale_fact_revalidation_private",
  "open_loop_resume_candidate",
  "useful_feedback_boosts_value",
  "missing_constraint_question",
  "private_safe_source_recall_supports_candidate",
  "agent_pulse_disabled",
  "dynamic_pulse_disabled",
  "user_not_opted_in",
  "quiet_hours_active",
  "cooldown_active",
  "daily_cap_reached",
  "active_mission_running",
  "public_mode_private_evidence",
  "source_recall_disabled",
  "source_recall_blocked",
  "source_recall_forgotten",
  "source_recall_redacted",
  "source_recall_quarantined",
  "source_recall_expired",
  "source_recall_public_unsafe",
  "assistant_only_source",
  "task_summary_only_source",
  "media_document_without_policy",
  "model_unavailable",
  "malformed_semantic_inquiry_candidate",
  "low_confidence_model_candidate",
  "low_expected_user_value",
  "repeated_ignored_pulse",
  "repeated_dismissed_pulse",
  "exact_pulse_off",
  "prompt_injection_approve",
  "prompt_injection_route_metadata",
  "prompt_injection_task_complete",
  "prompt_injection_ignore_quiet_hours"
] as const;

test("Dynamic Pulse semantic inquiry matrix executes all required scenarios", async () => {
  const scenarios = await loadDynamicPulseSemanticInquiryScenarios();
  const ids = new Set(scenarios.map((scenario) => scenario.id));
  for (const id of REQUIRED_SCENARIO_IDS) {
    assert.equal(ids.has(id), true, `missing scenario ${id}`);
  }

  const matrix = await runDynamicPulseSemanticInquiryMatrix(scenarios);
  assert.equal(matrix.artifactKind, "dynamic_pulse_semantic_inquiry_matrix");
  assert.equal(matrix.summary.failed, 0);
  assert.equal(matrix.summary.passed, scenarios.length);
  assert.equal(matrix.topLevelStatus.status, "PASS");
  assert.equal(matrix.summary.suppressionBalancePass, true);
  assert.ok(matrix.summary.suppressions >= matrix.summary.emissions);
  assert.equal(matrix.artifactPrivacyProof.localDesktopPathPresentInArtifact, false);
  assert.equal(matrix.artifactPrivacyProof.tokenShapedSecretPresentInArtifact, false);
});

test("Dynamic Pulse matrix keeps authority flags false and distinguishes proof modes", async () => {
  const matrix = await runDynamicPulseSemanticInquiryMatrix(
    await loadDynamicPulseSemanticInquiryScenarios()
  );
  const schemaOnly = matrix.results.filter((result) => result.evidenceMode === "schema_only");
  const blockedDependency = matrix.results.filter(
    (result) => result.evidenceMode === "live_dependency_blocked"
  );

  assert.ok(schemaOnly.length >= 2);
  assert.ok(blockedDependency.length >= 1);
  for (const result of matrix.results) {
    assert.equal(result.authorityFlags.outreachAuthority, false);
    assert.equal(result.authorityFlags.memoryWriteAuthority, false);
    assert.equal(result.authorityFlags.truthAuthority, false);
    assert.equal(result.authorityFlags.approvalAuthority, false);
    assert.equal(result.authorityFlags.deliveryPermission, false);
    if (result.evidenceMode === "schema_only") {
      assert.equal(result.messageEmitted, false);
      assert.equal(result.candidateProposed, false);
      assert.equal(result.proofCategory, "schema_validation");
    }
    if (result.evidenceMode === "live_dependency_blocked") {
      assert.equal(result.liveDependencyStatus, "BLOCKED");
      assert.equal(result.messageEmitted, false);
    }
  }
});

test("Dynamic Pulse matrix suppresses Source Recall lifecycle and prompt-injection cases", async () => {
  const matrix = await runDynamicPulseSemanticInquiryMatrix(
    await loadDynamicPulseSemanticInquiryScenarios()
  );
  const blockedIds = [
    "source_recall_forgotten",
    "source_recall_redacted",
    "source_recall_quarantined",
    "source_recall_expired",
    "source_recall_public_unsafe",
    "assistant_only_source",
    "task_summary_only_source",
    "media_document_without_policy",
    "prompt_injection_approve",
    "prompt_injection_route_metadata",
    "prompt_injection_task_complete",
    "prompt_injection_ignore_quiet_hours"
  ];

  for (const id of blockedIds) {
    const result = matrix.results.find((candidate) => candidate.id === id);
    assert.equal(result?.status, "PASS", id);
    assert.equal(result?.candidateProposed, true, id);
    assert.equal(result?.messageEmitted, false, id);
    assert.equal(result?.suppressionReason, "source_recall_unusable", id);
  }
});

test("Dynamic Pulse matrix proves outcome learning without increasing default proactivity", async () => {
  const matrix = await runDynamicPulseSemanticInquiryMatrix(
    await loadDynamicPulseSemanticInquiryScenarios()
  );
  const useful = matrix.results.find((result) => result.id === "useful_feedback_boosts_value");
  const ignored = matrix.results.find((result) => result.id === "repeated_ignored_pulse");
  const dismissed = matrix.results.find((result) => result.id === "repeated_dismissed_pulse");

  assert.equal(useful?.messageEmitted, true);
  assert.equal(useful?.outcomeLearningEffect, "boosted_similar_useful_candidate");
  assert.equal(ignored?.messageEmitted, false);
  assert.equal(ignored?.outcomeLearningEffect, "suppressed_repeated_ignored");
  assert.equal(dismissed?.messageEmitted, false);
  assert.equal(dismissed?.outcomeLearningEffect, "suppressed_repeated_dismissed");
  assert.ok(matrix.summary.suppressions >= matrix.summary.emissions);
});
