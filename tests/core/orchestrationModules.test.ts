/**
 * @fileoverview Tests extracted orchestration contracts and mission/failure helper modules.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildMissionCheckpoint,
  deriveFailureTaxonomyFromRun,
  mapFailureTaxonomyCode,
  resolveMissionFailureBlockCode,
  resolveMissionFailureRootCause,
  shouldEmitMissionPostmortem
} from "../../src/core/orchestration/orchestratorReceipts";
import {
  type ActionRunResult,
  type ConstraintViolationCode,
  type GovernorId,
  type TaskRunResult
} from "../../src/core/types";
import { type RetryBudgetDecision } from "../../src/core/stage6_85RecoveryPolicy";

function buildTaskResult(actionResults: ActionRunResult[]): TaskRunResult {
  return {
    task: {
      id: "task_orchestration_modules",
      goal: "test",
      userInput: "test",
      createdAt: new Date().toISOString()
    },
    plan: {
      taskId: "task_orchestration_modules",
      plannerNotes: "stub",
      actions: actionResults.map((entry) => entry.action)
    },
    actionResults,
    summary: "stub summary",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  };
}

function buildApprovedResult(actionId: string, actionType: "respond"): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: actionType,
      description: "approved action",
      params: {},
      estimatedCostUsd: 0.01
    },
    mode: "fast_path",
    approved: true,
    output: "approved",
    executionStatus: "success",
    blockedBy: [],
    violations: [],
    votes: []
  };
}

function buildBlockedConstraintResult(
  actionId: string,
  code: ConstraintViolationCode = "DELETE_OUTSIDE_SANDBOX"
): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "delete_file",
      description: "blocked action",
      params: {},
      estimatedCostUsd: 0.05
    },
    mode: "escalation_path",
    approved: false,
    output: "blocked",
    blockedBy: [code],
    violations: [
      {
        code,
        message: "Constraint blocked execution."
      }
    ],
    votes: []
  };
}

function buildBlockedGovernanceResult(actionId: string): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "self_modify",
      description: "governance blocked action",
      params: {},
      estimatedCostUsd: 0.05
    },
    mode: "escalation_path",
    approved: false,
    output: "blocked",
    blockedBy: ["security"],
    violations: [],
    votes: [
      {
        governorId: "security" satisfies GovernorId,
        approve: false,
        reason: "Unsafe self-modification denied.",
        confidence: 1
      }
    ]
  };
}

test("buildMissionCheckpoint returns deterministic idempotency metadata", () => {
  const checkpoint = buildMissionCheckpoint(
    "task_orchestration_modules",
    2,
    buildApprovedResult("action_1", "respond"),
    3,
    "2026-03-07T12:00:00.000Z"
  );

  assert.deepEqual(checkpoint, {
    missionId: "task_orchestration_modules",
    missionAttemptId: 2,
    phase: "verify",
    actionType: "respond",
    observedAt: "2026-03-07T12:00:00.000Z",
    idempotencyKey: "task_orchestration_modules:2:action_1:3",
    actionId: "action_1"
  });
});

test("mission postmortem helpers prefer retry-budget stops and canonical stage675 codes", () => {
  const retryDecision: RetryBudgetDecision = {
    shouldRetry: false,
    nextAttempt: 2,
    blockCode: "MISSION_STOP_LIMIT_REACHED",
    reason: "Mission retry budget exhausted."
  };
  const actionResults = [buildBlockedConstraintResult("delete_1", "DELETE_OUTSIDE_SANDBOX")];

  assert.equal(resolveMissionFailureBlockCode(actionResults, retryDecision), "MISSION_STOP_LIMIT_REACHED");
  assert.equal(resolveMissionFailureRootCause(actionResults, retryDecision), "Mission retry budget exhausted.");
  assert.equal(shouldEmitMissionPostmortem(actionResults, retryDecision), true);
});

test("mission failure helpers fall back to blocked action details when retry policy is absent", () => {
  const governanceBlocked = buildBlockedGovernanceResult("self_modify_1");

  assert.equal(
    resolveMissionFailureRootCause([governanceBlocked], null),
    "Unsafe self-modification denied."
  );
  assert.equal(shouldEmitMissionPostmortem([governanceBlocked], null), false);
});

test("deriveFailureTaxonomyFromRun classifies blocked and objective-miss runs deterministically", () => {
  const blockedResult = buildTaskResult([buildBlockedConstraintResult("delete_2")]);
  const objectiveMiss = buildTaskResult([]);

  assert.deepEqual(deriveFailureTaxonomyFromRun(blockedResult), {
    failureCategory: "constraint",
    failureCode: "constraint_blocked"
  });
  assert.deepEqual(deriveFailureTaxonomyFromRun(objectiveMiss), {
    failureCategory: "objective",
    failureCode: "objective_not_met"
  });
});

test("mapFailureTaxonomyCode preserves the canonical category-to-code mapping", () => {
  assert.equal(mapFailureTaxonomyCode("reasoning"), "reasoning_planner_failed");
  assert.equal(mapFailureTaxonomyCode("human_feedback"), "human_feedback_required");
  assert.equal(mapFailureTaxonomyCode("quality"), "quality_rejected");
});
