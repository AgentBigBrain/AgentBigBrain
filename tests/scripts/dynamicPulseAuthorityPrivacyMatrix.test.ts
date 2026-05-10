/**
 * @fileoverview Tests Agent Pulse authority/privacy evidence matrix behavior.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  loadDynamicPulseAuthorityPrivacyScenarios,
  runDynamicPulseAuthorityPrivacyMatrix
} from "../../scripts/evidence/dynamicPulseAuthorityPrivacyMatrix";

const REQUIRED_SCENARIO_IDS = [
  "private_allowed_permitted_reason",
  "typed_delivery_metadata_before_job",
  "respond_only_metadata_enforced",
  "pulse_off_user_global",
  "agent_pulse_disabled",
  "dynamic_pulse_disabled",
  "quiet_hours_active",
  "cooldown_active",
  "daily_cap_reached",
  "active_mission_other_session",
  "no_private_route",
  "public_mode_private_evidence",
  "public_prompt_minimized",
  "source_recall_disabled",
  "source_recall_blocked",
  "internal_pulse_prompt_not_task_input",
  "pulse_emit_no_sent_delivery_claim",
  "pulse_job_attempts_file_action",
  "wrong_session_reply_not_engagement",
  "exact_pulse_off_not_engagement",
  "startup_tick_disabled",
  "dynamic_reason_not_allowlisted",
  "mock_schema_not_live_proof"
] as const;

test("Dynamic Pulse authority/privacy matrix executes required scenarios", async () => {
  const scenarios = await loadDynamicPulseAuthorityPrivacyScenarios();
  const ids = new Set(scenarios.map((scenario) => scenario.id));
  for (const id of REQUIRED_SCENARIO_IDS) {
    assert.equal(ids.has(id), true, `missing scenario ${id}`);
  }

  const matrix = await runDynamicPulseAuthorityPrivacyMatrix(scenarios);
  assert.equal(matrix.artifactKind, "dynamic_pulse_authority_privacy_matrix");
  assert.equal(matrix.summary.failed, 0);
  assert.equal(matrix.summary.passed, scenarios.length);
  assert.equal(matrix.topLevelStatus.status, "PASS");
  assert.equal(matrix.summary.suppressionBalancePass, true);
  assert.equal(matrix.summary.noIncreasedDefaultProactivity, true);
  assert.equal(matrix.artifactPrivacyProof.localDesktopPathPresentInArtifact, false);
  assert.equal(matrix.artifactPrivacyProof.tokenShapedSecretPresentInArtifact, false);
});

test("Dynamic Pulse authority matrix proves typed gateway and respond-only metadata", async () => {
  const matrix = await runDynamicPulseAuthorityPrivacyMatrix(
    await loadDynamicPulseAuthorityPrivacyScenarios()
  );
  const emitted = matrix.rows.filter((row) => row.messageEmitted);
  assert.ok(emitted.length > 0);
  for (const row of emitted) {
    assert.equal(row.policyGatewayDecision, "ALLOWED", row.scenarioId);
    assert.equal(row.pulseDecisionRecordPresent, true, row.scenarioId);
    assert.equal(row.jobMetadataPresent, true, row.scenarioId);
    assert.equal(row.respondOnlyEnforced, true, row.scenarioId);
    assert.notEqual(row.proofCategory, "schema_validation", row.scenarioId);
  }
});

test("Dynamic Pulse authority matrix suppresses privacy, source, and policy negatives", async () => {
  const matrix = await runDynamicPulseAuthorityPrivacyMatrix(
    await loadDynamicPulseAuthorityPrivacyScenarios()
  );
  const expectations = new Map([
    ["public_mode_private_evidence", "PUBLIC_PRIVACY_BLOCKED"],
    ["source_recall_disabled", "SOURCE_RECALL_BLOCKED"],
    ["source_recall_blocked", "SOURCE_RECALL_BLOCKED"],
    ["pulse_emit_no_sent_delivery_claim", "RUNTIME_ACTION_NOT_SCHEDULER_AUTHORIZED"],
    ["dynamic_reason_not_allowlisted", "REASON_NOT_ALLOWED"],
    ["active_mission_other_session", "ACTIVE_MISSION"]
  ]);
  for (const [id, decisionCode] of expectations) {
    const row = matrix.rows.find((candidate) => candidate.scenarioId === id);
    assert.equal(row?.status, "PASS", id);
    assert.equal(row?.policyGatewayDecision, decisionCode, id);
    assert.equal(row?.messageEmitted, false, id);
  }
});

test("Dynamic Pulse authority matrix distinguishes schema proof and outcome binding", async () => {
  const matrix = await runDynamicPulseAuthorityPrivacyMatrix(
    await loadDynamicPulseAuthorityPrivacyScenarios()
  );
  const schema = matrix.rows.find((row) => row.scenarioId === "mock_schema_not_live_proof");
  const wrongSession = matrix.rows.find((row) => row.scenarioId === "wrong_session_reply_not_engagement");
  const pulseOff = matrix.rows.find((row) => row.scenarioId === "exact_pulse_off_not_engagement");

  assert.equal(schema?.evidenceMode, "schema_only");
  assert.equal(schema?.messageEmitted, false);
  assert.equal(schema?.proofCategory, "schema_validation");
  assert.equal(wrongSession?.outcomeBindingResult, "wrong_session_rejected");
  assert.equal(pulseOff?.outcomeBindingResult, "control_not_engagement");
});
