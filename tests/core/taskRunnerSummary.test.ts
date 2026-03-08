/**
 * @fileoverview Tests canonical task-runner result builders extracted into the orchestration subsystem.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildApprovedActionResult,
  buildBlockedActionResult
} from "../../src/core/orchestration/taskRunnerSummary";

const BASE_ACTION = {
  id: "action_task_runner_summary_1",
  type: "respond" as const,
  description: "respond to the user",
  params: {},
  estimatedCostUsd: 0.01
};

test("buildBlockedActionResult preserves runtime fields and stable defaults", () => {
  const result = buildBlockedActionResult({
    action: BASE_ACTION,
    mode: "fast_path",
    output: "blocked",
    executionStatus: "failed",
    executionFailureCode: "ACTION_EXECUTION_FAILED",
    executionMetadata: {
      shellExitCode: 1
    },
    blockedBy: ["ACTION_EXECUTION_FAILED"],
    violations: [
      {
        code: "ACTION_EXECUTION_FAILED",
        message: "Execution failed."
      }
    ]
  });

  assert.equal(result.approved, false);
  assert.equal(result.output, "blocked");
  assert.equal(result.executionStatus, "failed");
  assert.equal(result.executionFailureCode, "ACTION_EXECUTION_FAILED");
  assert.deepEqual(result.blockedBy, ["ACTION_EXECUTION_FAILED"]);
  assert.deepEqual(result.violations, [
    {
      code: "ACTION_EXECUTION_FAILED",
      message: "Execution failed."
    }
  ]);
  assert.deepEqual(result.votes, []);
});

test("buildApprovedActionResult preserves governance decisions and clears block fields", () => {
  const result = buildApprovedActionResult({
    action: BASE_ACTION,
    mode: "escalation_path",
    output: "done",
    executionStatus: "success",
    executionMetadata: {
      missionAttemptId: 1
    },
    votes: [
      {
        governorId: "safety",
        approve: true,
        reason: "Safe.",
        confidence: 1
      }
    ],
    decision: {
      approved: true,
      yesVotes: 1,
      noVotes: 0,
      threshold: 1,
      dissent: []
    }
  });

  assert.equal(result.approved, true);
  assert.equal(result.output, "done");
  assert.equal(result.executionStatus, "success");
  assert.deepEqual(result.blockedBy, []);
  assert.deepEqual(result.violations, []);
  assert.equal(result.votes.length, 1);
  assert.equal(result.decision?.approved, true);
});
