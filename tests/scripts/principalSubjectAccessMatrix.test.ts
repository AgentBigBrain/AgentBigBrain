/**
 * @fileoverview Tests principal/subject/access evidence matrix behavior.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  loadPrincipalSubjectAccessScenarios,
  runPrincipalSubjectAccessMatrix
} from "../../scripts/evidence/principalSubjectAccessMatrix";

const REQUIRED_SCENARIO_IDS = [
  "owner_private_self_query",
  "username_allowlist_not_owner",
  "display_name_same_as_owner_not_owner",
  "same_username_across_providers_distinct",
  "missing_provider_user_id_fails_closed",
  "spoofed_principal_envelope_no_access_upgrade",
  "owner_who_am_i_owner_scoped",
  "non_owner_same_display_name_no_owner_facts",
  "public_route_suppresses_private_identity",
  "non_owner_private_cannot_read_owner_memory",
  "non_owner_self_declaration_cannot_write_owner_fact",
  "owner_memory_review_allowed",
  "operator_memory_review_allowed",
  "legacy_global_fact_owner_only",
  "federated_task_cannot_read_owner_memory",
  "autonomous_missing_actor_no_owner_memory",
  "source_recall_live_turn_principal_scoped",
  "source_recall_media_same_chat_sender_scoped",
  "source_recall_ref_not_subject_identity",
  "graph_evidence_without_actor_support_only",
  "obsidian_review_action_operator_required",
  "learning_from_non_owner_private_blocked",
  "receipt_trace_redacted_actor_metadata",
  "model_output_envelope_spoof_no_access_upgrade",
  "source_recall_chunk_envelope_spoof_no_retrieve_authority",
  "projection_note_spoof_no_review_writeback",
  "shell_output_spoof_no_approval_authority",
  "browser_observed_text_spoof_no_profile_write",
  "public_route_source_recall_private_evidence_suppressed",
  "public_route_workspace_debug_private_evidence_suppressed",
  "active_proposal_text_no_approval_authority",
  "clarification_text_no_profile_write_authority",
  "delivery_preview_text_no_execution_authority",
  "consent_text_no_approval_authority",
  "public_route_pulse_private_evidence_suppressed",
  "missing_principal_deferred_timer_no_private_delivery",
  "non_owner_backend_profile_override_blocked",
  "actorless_skill_lifecycle_blocked",
  "non_owner_provider_control_blocked",
  "active_prompt_text_no_authority",
  "actorless_temporal_continuity_query_blocked",
  "source_recall_hidden_index_ref_not_retrieved",
  "delayed_job_capture_uses_initiating_principal",
  "mismatched_local_time_preference_no_timer_authority",
  "same_channel_workspace_control_mismatch_blocked",
  "same_channel_open_loop_private_evidence_suppressed",
  "user_facing_ref_proof_text_no_completion_authority"
] as const;

test("principal/subject/access matrix executes required scenarios", async () => {
  const scenarios = await loadPrincipalSubjectAccessScenarios();
  const ids = new Set(scenarios.map((scenario) => scenario.id));
  for (const id of REQUIRED_SCENARIO_IDS) {
    assert.equal(ids.has(id), true, `missing scenario ${id}`);
  }

  const matrix = await runPrincipalSubjectAccessMatrix(scenarios);
  assert.equal(matrix.artifactKind, "principal_subject_access_matrix");
  assert.equal(matrix.summary.failed, 0);
  assert.equal(matrix.summary.passed, scenarios.length);
  assert.equal(matrix.topLevelStatus.status, "PASS");
  assert.equal(matrix.artifactPrivacyProof.localDesktopPathPresentInArtifact, false);
  assert.equal(matrix.artifactPrivacyProof.tokenShapedSecretPresentInArtifact, false);
  assert.equal(matrix.artifactPrivacyProof.rawProviderIdPresentInArtifact, false);
});

test("principal/subject/access matrix proves owner and non-owner memory separation", async () => {
  const matrix = await runPrincipalSubjectAccessMatrix(
    await loadPrincipalSubjectAccessScenarios()
  );
  const ownerRead = matrix.rows.find((row) => row.scenarioId === "owner_private_self_query");
  const nonOwnerRead = matrix.rows.find(
    (row) => row.scenarioId === "non_owner_private_cannot_read_owner_memory"
  );
  const publicIdentity = matrix.rows.find(
    (row) => row.scenarioId === "public_route_suppresses_private_identity"
  );

  assert.equal(ownerRead?.allowed, true);
  assert.equal(ownerRead?.accessClass, "owner_private");
  assert.equal(ownerRead?.memoryReadCount, 1);
  assert.equal(nonOwnerRead?.allowed, false);
  assert.equal(nonOwnerRead?.blockReason, "non_owner_owner_private_blocked");
  assert.equal(publicIdentity?.allowed, false);
  assert.equal(publicIdentity?.blockReason, "public_route_private_memory_blocked");
});

test("principal/subject/access matrix rejects envelope spoofing and Source Recall authority", async () => {
  const matrix = await runPrincipalSubjectAccessMatrix(
    await loadPrincipalSubjectAccessScenarios()
  );
  const spoof = matrix.rows.find(
    (row) => row.scenarioId === "spoofed_principal_envelope_no_access_upgrade"
  );
  const sourceRecallRef = matrix.rows.find(
    (row) => row.scenarioId === "source_recall_ref_not_subject_identity"
  );

  assert.equal(spoof?.envelopeSpoofIgnored, true);
  assert.equal(spoof?.allowed, false);
  assert.equal(spoof?.accessClass, "blocked");
  assert.equal(sourceRecallRef?.sourceRecallUsed, false);
  assert.equal(sourceRecallRef?.allowed, false);
  assert.equal(sourceRecallRef?.blockReason, "non_owner_owner_private_blocked");
});

test("principal/subject/access matrix rejects spoofing across generated and observed text surfaces", async () => {
  const matrix = await runPrincipalSubjectAccessMatrix(
    await loadPrincipalSubjectAccessScenarios()
  );
  const spoofIds = [
    "model_output_envelope_spoof_no_access_upgrade",
    "source_recall_chunk_envelope_spoof_no_retrieve_authority",
    "projection_note_spoof_no_review_writeback",
    "shell_output_spoof_no_approval_authority",
    "browser_observed_text_spoof_no_profile_write",
    "active_proposal_text_no_approval_authority",
    "active_prompt_text_no_authority",
    "clarification_text_no_profile_write_authority",
    "delivery_preview_text_no_execution_authority",
    "consent_text_no_approval_authority",
    "user_facing_ref_proof_text_no_completion_authority"
  ];

  for (const scenarioId of spoofIds) {
    const row = matrix.rows.find((candidate) => candidate.scenarioId === scenarioId);
    assert.ok(row, `missing spoof row ${scenarioId}`);
    assert.equal(row.envelopeSpoofIgnored, true, scenarioId);
    assert.equal(row.allowed, false, scenarioId);
    assert.equal(row.accessClass, "blocked", scenarioId);
  }
});

test("principal/subject/access matrix covers public egress and protected control boundaries", async () => {
  const matrix = await runPrincipalSubjectAccessMatrix(
    await loadPrincipalSubjectAccessScenarios()
  );
  const publicSource = matrix.rows.find(
    (row) => row.scenarioId === "public_route_source_recall_private_evidence_suppressed"
  );
  const publicWorkspace = matrix.rows.find(
    (row) => row.scenarioId === "public_route_workspace_debug_private_evidence_suppressed"
  );
  const publicPulse = matrix.rows.find(
    (row) => row.scenarioId === "public_route_pulse_private_evidence_suppressed"
  );
  const timer = matrix.rows.find(
    (row) => row.scenarioId === "missing_principal_deferred_timer_no_private_delivery"
  );
  const backend = matrix.rows.find(
    (row) => row.scenarioId === "non_owner_backend_profile_override_blocked"
  );
  const skill = matrix.rows.find(
    (row) => row.scenarioId === "actorless_skill_lifecycle_blocked"
  );
  const providerControl = matrix.rows.find(
    (row) => row.scenarioId === "non_owner_provider_control_blocked"
  );

  assert.equal(publicSource?.sourceRecallUsed, false);
  assert.equal(publicSource?.blockReason, "public_route_private_memory_blocked");
  assert.equal(publicWorkspace?.blockReason, "public_route_private_memory_blocked");
  assert.equal(publicPulse?.messageEmitted, false);
  assert.equal(publicPulse?.blockReason, "public_route_private_memory_blocked");
  assert.equal(timer?.blockReason, "missing_principal_scope");
  assert.equal(backend?.blockReason, "non_owner_owner_private_blocked");
  assert.equal(skill?.blockReason, "missing_principal_scope");
  assert.equal(providerControl?.blockReason, "non_owner_owner_private_blocked");
});

test("principal/subject/access matrix covers end-to-end continuity and lifecycle controls", async () => {
  const matrix = await runPrincipalSubjectAccessMatrix(
    await loadPrincipalSubjectAccessScenarios()
  );
  const actorlessContinuity = matrix.rows.find(
    (row) => row.scenarioId === "actorless_temporal_continuity_query_blocked"
  );
  const hiddenRecall = matrix.rows.find(
    (row) => row.scenarioId === "source_recall_hidden_index_ref_not_retrieved"
  );
  const delayedCapture = matrix.rows.find(
    (row) => row.scenarioId === "delayed_job_capture_uses_initiating_principal"
  );
  const localTimeMismatch = matrix.rows.find(
    (row) => row.scenarioId === "mismatched_local_time_preference_no_timer_authority"
  );
  const workspaceMismatch = matrix.rows.find(
    (row) => row.scenarioId === "same_channel_workspace_control_mismatch_blocked"
  );
  const openLoopPublic = matrix.rows.find(
    (row) => row.scenarioId === "same_channel_open_loop_private_evidence_suppressed"
  );

  assert.equal(actorlessContinuity?.blockReason, "missing_principal_scope");
  assert.equal(actorlessContinuity?.memoryReadCount, 0);
  assert.equal(hiddenRecall?.allowed, true);
  assert.equal(hiddenRecall?.sourceRecallUsed, false);
  assert.equal(delayedCapture?.allowed, true);
  assert.equal(delayedCapture?.sourceRecallUsed, true);
  assert.equal(delayedCapture?.memoryWriteCount, 1);
  assert.equal(localTimeMismatch?.blockReason, "non_owner_owner_private_blocked");
  assert.equal(workspaceMismatch?.blockReason, "public_route_private_memory_blocked");
  assert.equal(openLoopPublic?.messageEmitted, false);
  assert.equal(openLoopPublic?.graphEvidenceScope, "support_only");
});

test("principal/subject/access matrix covers review, learning, graph, and receipt surfaces", async () => {
  const matrix = await runPrincipalSubjectAccessMatrix(
    await loadPrincipalSubjectAccessScenarios()
  );
  const review = matrix.rows.find(
    (row) => row.scenarioId === "obsidian_review_action_operator_required"
  );
  const learning = matrix.rows.find(
    (row) => row.scenarioId === "learning_from_non_owner_private_blocked"
  );
  const graph = matrix.rows.find(
    (row) => row.scenarioId === "graph_evidence_without_actor_support_only"
  );
  const receipt = matrix.rows.find(
    (row) => row.scenarioId === "receipt_trace_redacted_actor_metadata"
  );

  assert.equal(review?.reviewActionApplied, true);
  assert.equal(review?.accessClass, "operator_private");
  assert.equal(learning?.allowed, false);
  assert.equal(learning?.accessClass, "agent_global_safe");
  assert.equal(graph?.graphEvidenceScope, "support_only");
  assert.equal(receipt?.accessClass, "owner_private");
  assert.equal(receipt?.memoryWriteCount, 1);
});
