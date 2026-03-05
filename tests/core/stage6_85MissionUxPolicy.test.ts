/**
 * @fileoverview Tests deterministic Stage 6.85 mission-UX state transitions, approval-default policy, diff formatting, and result-envelope normalization.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildMissionUxResultEnvelope,
  deriveMissionUxState,
  determineApprovalGranularity,
  formatStableApprovalDiff
} from "../../src/core/stage6_85MissionUxPolicy";

test("deriveMissionUxState enforces deterministic precedence across blocked/completed/approval/executing/planning", () => {
  const blocked = deriveMissionUxState({
    hasCompletedOutcome: true,
    hasBlockingOutcome: true,
    awaitingApproval: true,
    hasInFlightExecution: true
  });
  assert.equal(blocked, "blocked");

  const completed = deriveMissionUxState({
    hasCompletedOutcome: true,
    hasBlockingOutcome: false,
    awaitingApproval: true,
    hasInFlightExecution: true
  });
  assert.equal(completed, "completed");

  const awaiting = deriveMissionUxState({
    hasCompletedOutcome: false,
    hasBlockingOutcome: false,
    awaitingApproval: true,
    hasInFlightExecution: true
  });
  assert.equal(awaiting, "awaiting_approval");

  const executing = deriveMissionUxState({
    hasCompletedOutcome: false,
    hasBlockingOutcome: false,
    awaitingApproval: false,
    hasInFlightExecution: true
  });
  assert.equal(executing, "executing");

  const planning = deriveMissionUxState({
    hasCompletedOutcome: false,
    hasBlockingOutcome: false,
    awaitingApproval: false,
    hasInFlightExecution: false
  });
  assert.equal(planning, "planning");
});

test("determineApprovalGranularity fails closed to approve_step and escalation when tier derivation is unavailable", () => {
  const decision = determineApprovalGranularity({
    stepTiers: [],
    playbookAllowlistedForApproveAll: false,
    tierDerivationFailed: true
  });
  assert.equal(decision.approvalMode, "approve_step");
  assert.equal(decision.requiresEscalationPath, true);
});

test("determineApprovalGranularity defaults Tier >= 3 flows to approve_step unless allowlisted", () => {
  const notAllowlisted = determineApprovalGranularity({
    stepTiers: [1, 3],
    playbookAllowlistedForApproveAll: false,
    tierDerivationFailed: false
  });
  assert.equal(notAllowlisted.approvalMode, "approve_step");
  assert.equal(notAllowlisted.requiresEscalationPath, true);

  const allowlisted = determineApprovalGranularity({
    stepTiers: [3, 3],
    playbookAllowlistedForApproveAll: true,
    tierDerivationFailed: false
  });
  assert.equal(allowlisted.approvalMode, "approve_all");
  assert.equal(allowlisted.requiresEscalationPath, true);
});

test("formatStableApprovalDiff preserves deterministic order and normalizes line endings", () => {
  const formatted = formatStableApprovalDiff(["+ add block\r\n", "- remove block"]);
  assert.equal(formatted, "01. + add block\n02. - remove block");
});

test("buildMissionUxResultEnvelope returns sorted deduplicated refs and trimmed fields", () => {
  const envelope = buildMissionUxResultEnvelope({
    missionId: "mission_6_85_b_001",
    state: "awaiting_approval",
    summary: "  awaiting human approval  ",
    evidenceRefs: ["trace_2", "trace_1", "trace_2", "  "],
    receiptRefs: ["receipt_b", "receipt_a", "receipt_a"],
    nextStepSuggestion: "  approve or request adjustment "
  });

  assert.deepEqual(envelope.evidenceRefs, ["trace_1", "trace_2"]);
  assert.deepEqual(envelope.receiptRefs, ["receipt_a", "receipt_b"]);
  assert.equal(envelope.summary, "awaiting human approval");
  assert.equal(envelope.nextStepSuggestion, "approve or request adjustment");
});
