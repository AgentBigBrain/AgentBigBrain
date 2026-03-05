/**
 * @fileoverview Tests deterministic Stage 6.85 recovery policy for checkpoint ordering, retry-budget enforcement, resume safety, and postmortem generation.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildMissionPostmortem,
  evaluateResumeSafety,
  evaluateRetryBudget,
  resolveLastDurableCheckpoint,
  sortMissionCheckpoints
} from "../../src/core/stage6_85RecoveryPolicy";
import { MissionCheckpointV1 } from "../../src/core/types";

/**
 * Implements `buildCheckpoint` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildCheckpoint(
  missionAttemptId: number,
  observedAt: string,
  actionId: string
): MissionCheckpointV1 {
  return {
    missionId: "mission_685_d_001",
    missionAttemptId,
    phase: "build",
    actionType: "run_skill",
    observedAt,
    idempotencyKey: `idem_${actionId}`,
    actionId
  };
}

/**
 * Implements `sortsCheckpointsDeterministicallyAndResolvesLastDurable` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function sortsCheckpointsDeterministicallyAndResolvesLastDurable(): void {
  const checkpoints = [
    buildCheckpoint(2, "2026-02-27T00:02:00.000Z", "b_action"),
    buildCheckpoint(1, "2026-02-27T00:01:00.000Z", "a_action"),
    buildCheckpoint(2, "2026-02-27T00:02:00.000Z", "a_action")
  ];
  const sorted = sortMissionCheckpoints(checkpoints);
  assert.equal(sorted[0]?.missionAttemptId, 1);
  assert.equal(sorted[1]?.actionId, "a_action");
  assert.equal(sorted[2]?.actionId, "b_action");
  const durable = resolveLastDurableCheckpoint(checkpoints);
  assert.equal(durable?.actionId, "b_action");
}

/**
 * Implements `enforcesRetryBudgetFailClosedAtStopLimit` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function enforcesRetryBudgetFailClosedAtStopLimit(): void {
  const allowed = evaluateRetryBudget(1, 3);
  assert.equal(allowed.shouldRetry, true);
  assert.equal(allowed.nextAttempt, 2);
  assert.equal(allowed.blockCode, null);

  const blocked = evaluateRetryBudget(3, 3);
  assert.equal(blocked.shouldRetry, false);
  assert.equal(blocked.blockCode, "MISSION_STOP_LIMIT_REACHED");
}

/**
 * Implements `enforcesResumeSafetyAgainstApprovalAndFreshnessDrift` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function enforcesResumeSafetyAgainstApprovalAndFreshnessDrift(): void {
  const allowed = evaluateResumeSafety({
    approvalUses: 0,
    approvalMaxUses: 2,
    freshnessValid: true,
    diffHashMatches: true
  });
  assert.equal(allowed.allowed, true);

  const maxUsesBlocked = evaluateResumeSafety({
    approvalUses: 2,
    approvalMaxUses: 2,
    freshnessValid: true,
    diffHashMatches: true
  });
  assert.equal(maxUsesBlocked.allowed, false);
  assert.equal(maxUsesBlocked.blockCode, "APPROVAL_MAX_USES_EXCEEDED");

  const staleBlocked = evaluateResumeSafety({
    approvalUses: 1,
    approvalMaxUses: 2,
    freshnessValid: false,
    diffHashMatches: true
  });
  assert.equal(staleBlocked.allowed, false);
  assert.equal(staleBlocked.blockCode, "STATE_STALE_REPLAN_REQUIRED");
}

/**
 * Implements `buildsDeterministicMissionPostmortemArtifact` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildsDeterministicMissionPostmortemArtifact(): void {
  const postmortem = buildMissionPostmortem({
    missionId: "mission_685_d_001",
    missionAttemptId: 2,
    failedAt: "2026-02-27T00:03:00.000Z",
    blockCode: "STATE_STALE_REPLAN_REQUIRED",
    rootCause: "Freshness watermark exceeded before write execution.",
    checkpoints: [
      buildCheckpoint(1, "2026-02-27T00:01:00.000Z", "a_action"),
      buildCheckpoint(2, "2026-02-27T00:02:00.000Z", "b_action")
    ]
  });
  assert.equal(postmortem.blockCode, "STATE_STALE_REPLAN_REQUIRED");
  assert.equal(postmortem.lastDurableCheckpoint?.actionId, "b_action");
  assert.equal(postmortem.remediationSteps.length, 3);
}

test(
  "stage 6.85 recovery policy sorts checkpoints deterministically and resolves last durable checkpoint",
  sortsCheckpointsDeterministicallyAndResolvesLastDurable
);
test(
  "stage 6.85 recovery policy enforces retry stop limits fail-closed",
  enforcesRetryBudgetFailClosedAtStopLimit
);
test(
  "stage 6.85 recovery policy blocks resume on approval and freshness safety violations",
  enforcesResumeSafetyAgainstApprovalAndFreshnessDrift
);
test(
  "stage 6.85 recovery policy builds deterministic mission postmortem artifacts",
  buildsDeterministicMissionPostmortemArtifact
);
