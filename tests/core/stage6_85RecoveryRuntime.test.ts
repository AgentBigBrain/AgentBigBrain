/**
 * @fileoverview Tests canonical Stage 6.85 recovery runtime helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildRecoveryAttemptFingerprint,
  buildMissionPostmortem,
  evaluateStructuredRecoveryPolicy,
  evaluateResumeSafety,
  evaluateRetryBudget,
  resolveLastDurableCheckpoint,
  sortMissionCheckpoints
} from "../../src/core/stage6_85/recovery";
import { MissionCheckpointV1 } from "../../src/core/types";

function buildCheckpoint(
  missionAttemptId: number,
  observedAt: string,
  actionId: string
): MissionCheckpointV1 {
  return {
    missionId: "mission_685_runtime_recovery",
    missionAttemptId,
    phase: "build",
    actionType: "run_skill",
    observedAt,
    idempotencyKey: `idem_${actionId}`,
    actionId
  };
}

test("stage6_85 recovery runtime preserves checkpoint ordering and durable-checkpoint selection", () => {
  const checkpoints = [
    buildCheckpoint(2, "2026-02-27T00:02:00.000Z", "b_action"),
    buildCheckpoint(1, "2026-02-27T00:01:00.000Z", "a_action"),
    buildCheckpoint(2, "2026-02-27T00:02:00.000Z", "a_action")
  ];
  const sorted = sortMissionCheckpoints(checkpoints);
  assert.equal(sorted[0]?.missionAttemptId, 1);
  assert.equal(resolveLastDurableCheckpoint(checkpoints)?.actionId, "b_action");
});

test("stage6_85 recovery runtime preserves retry-budget and resume-safety fail-closed behavior", () => {
  const retryDecision = evaluateRetryBudget(3, 3);
  assert.equal(retryDecision.shouldRetry, false);
  assert.equal(retryDecision.blockCode, "MISSION_STOP_LIMIT_REACHED");

  const resumeDecision = evaluateResumeSafety({
    approvalUses: 2,
    approvalMaxUses: 2,
    freshnessValid: true,
    diffHashMatches: true
  });
  assert.equal(resumeDecision.allowed, false);
  assert.equal(resumeDecision.blockCode, "APPROVAL_MAX_USES_EXCEEDED");
});

test("stage6_85 recovery runtime preserves deterministic postmortem shaping", () => {
  const postmortem = buildMissionPostmortem({
    missionId: "mission_685_runtime_recovery",
    missionAttemptId: 2,
    failedAt: "2026-02-27T00:03:00.000Z",
    blockCode: "STATE_STALE_REPLAN_REQUIRED",
    rootCause: "Freshness watermark exceeded before write execution.",
    checkpoints: [
      buildCheckpoint(1, "2026-02-27T00:01:00.000Z", "a_action"),
      buildCheckpoint(2, "2026-02-27T00:02:00.000Z", "b_action")
    ]
  });
  assert.equal(postmortem.lastDurableCheckpoint?.actionId, "b_action");
  assert.equal(postmortem.remediationSteps.length, 3);
});

test("stage6_85 recovery runtime budgets structured repair attempts deterministically", () => {
  const decision = evaluateStructuredRecoveryPolicy({
    snapshot: {
      missionStopLimitReached: false,
      failureSignals: [
        {
          recoveryClass: "PROCESS_PORT_IN_USE",
          provenance: "runtime_live_run",
          sourceCode: "PROCESS_START_FAILED",
          actionType: "start_process",
          realm: "local_runtime",
          detail: "localhost port already occupied"
        }
      ],
      proofGaps: ["READINESS_PROOF_MISSING"],
      repairOptions: [
        {
          optionId: "retry_with_alternate_port",
          allowedRung: "bounded_repair_iteration",
          budgetHint: "single_repair_attempt",
          detail: "retry on a free loopback port"
        }
      ],
      remainingBudgetHint: "single_repair_attempt",
      environmentFacts: {}
    },
    attemptCounts: new Map<string, number>()
  });

  assert.equal(decision.outcome, "attempt_repair");
  assert.equal(decision.allowedRung, "bounded_repair_iteration");
  assert.equal(decision.builderPending, false);
  assert.equal(decision.maxAttempts, 1);
  assert.equal(decision.fingerprint, "PROCESS_PORT_IN_USE|retry_with_alternate_port|runtime_live_run|local_runtime|PROCESS_START_FAILED");
});

test("stage6_85 recovery runtime stops when a structured repair budget is exhausted", () => {
  const fingerprint = buildRecoveryAttemptFingerprint(
    {
      recoveryClass: "PROCESS_PORT_IN_USE",
      provenance: "runtime_live_run",
      sourceCode: "PROCESS_START_FAILED",
      actionType: "start_process",
      realm: "local_runtime",
      detail: null
    },
    "retry_with_alternate_port"
  );
  const decision = evaluateStructuredRecoveryPolicy({
    snapshot: {
      missionStopLimitReached: false,
      failureSignals: [
        {
          recoveryClass: "PROCESS_PORT_IN_USE",
          provenance: "runtime_live_run",
          sourceCode: "PROCESS_START_FAILED",
          actionType: "start_process",
          realm: "local_runtime",
          detail: null
        }
      ],
      proofGaps: ["READINESS_PROOF_MISSING"],
      repairOptions: [
        {
          optionId: "retry_with_alternate_port",
          allowedRung: "bounded_repair_iteration",
          budgetHint: "single_repair_attempt",
          detail: "retry on a free loopback port"
        }
      ],
      remainingBudgetHint: "single_repair_attempt",
      environmentFacts: {}
    },
    attemptCounts: new Map([[fingerprint, 1]])
  });

  assert.equal(decision.outcome, "stop");
  assert.equal(decision.allowedRung, "bounded_repair_iteration");
});
