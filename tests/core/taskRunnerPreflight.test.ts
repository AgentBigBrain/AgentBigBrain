/**
 * @fileoverview Tests canonical task-runner preflight checks extracted into the orchestration subsystem.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createBrainConfigFromEnv } from "../../src/core/config";
import { evaluateTaskRunnerPreflight } from "../../src/core/orchestration/taskRunnerPreflight";

function createBaseInput() {
  const baseConfig = createBrainConfigFromEnv({});
  const config = {
    ...baseConfig,
    permissions: {
      ...baseConfig.permissions,
      allowNetworkWriteAction: true
    }
  };
  return {
    action: {
      id: "action_task_runner_preflight_1",
      type: "respond" as const,
      description: "respond to the user",
      params: {},
      estimatedCostUsd: 0.01
    },
    approvalGrantById: new Map(),
    config,
    cumulativeEstimatedCostUsd: 0.01,
    estimatedModelSpendUsd: 0,
    idempotencyKey: "task_task_runner_preflight_1:1:action_task_runner_preflight_1",
    mode: "fast_path" as const,
    nowIso: "2026-03-07T12:00:00.000Z",
    startedAtMs: Date.now(),
    task: {
      id: "task_task_runner_preflight_1",
      goal: "respond",
      userInput: "respond",
      createdAt: "2026-03-07T12:00:00.000Z"
    }
  };
}

test("evaluateTaskRunnerPreflight blocks deadline overflow before proposal creation", () => {
  const input = createBaseInput();
  input.startedAtMs = Date.now() - input.config.limits.perTurnDeadlineMs - 1;

  const outcome = evaluateTaskRunnerPreflight(input);

  assert.equal(outcome.proposal, undefined);
  assert.deepEqual(outcome.blockedOutcome?.actionResult.blockedBy, ["GLOBAL_DEADLINE_EXCEEDED"]);
  assert.deepEqual(outcome.blockedOutcome?.traceDetails, {
    blockCode: "GLOBAL_DEADLINE_EXCEEDED",
    blockCategory: "runtime"
  });
});

test("evaluateTaskRunnerPreflight returns a proposal for non-network actions", () => {
  const outcome = evaluateTaskRunnerPreflight(createBaseInput());

  assert.equal(outcome.blockedOutcome, undefined);
  assert.equal(outcome.proposal?.taskId, "task_task_runner_preflight_1");
  assert.equal(outcome.connectorReceiptInput, undefined);
  assert.equal(outcome.approvalGrant, undefined);
});

test("evaluateTaskRunnerPreflight blocks network_write actions without JIT approval", () => {
  const input = createBaseInput();
  input.action = {
    id: "action_task_runner_preflight_network_missing_approval",
    type: "network_write",
    description: "write to connector",
    params: {
      url: "https://example.com/api",
      connector: "gmail",
      operation: "write",
      lastReadAtIso: "2026-03-07T12:00:00.000Z"
    },
    estimatedCostUsd: 0.08
  };
  input.idempotencyKey = "task_task_runner_preflight_1:1:action_task_runner_preflight_network_missing_approval";

  const outcome = evaluateTaskRunnerPreflight(input);

  assert.equal(outcome.proposal?.taskId, "task_task_runner_preflight_1");
  assert.deepEqual(outcome.blockedOutcome?.actionResult.blockedBy, ["JIT_APPROVAL_REQUIRED"]);
  assert.equal(outcome.approvalGrant, undefined);
});

test("evaluateTaskRunnerPreflight registers approval use and connector receipt seed for approved connector reads", () => {
  const input = createBaseInput();
  input.action = {
    id: "action_task_runner_preflight_network_success",
    type: "network_write",
    description: "read connector state",
    params: {
      url: "https://example.com/api",
      connector: "gmail",
      operation: "read",
      lastReadAtIso: "2026-03-07T12:00:00.000Z",
      approvalId: "approval_task_runner_preflight_1",
      approvedBy: "tester",
      approvalActionIds: ["action_task_runner_preflight_network_success"],
      idempotencyKeys: ["task_task_runner_preflight_1:1:action_task_runner_preflight_network_success"],
      payload: {
        query: "inbox"
      },
      externalIds: ["thread_123"]
    },
    estimatedCostUsd: 0.08
  };
  input.idempotencyKey = "task_task_runner_preflight_1:1:action_task_runner_preflight_network_success";

  const outcome = evaluateTaskRunnerPreflight(input);

  assert.equal(outcome.blockedOutcome, undefined);
  assert.equal(outcome.proposal?.taskId, "task_task_runner_preflight_1");
  assert.equal(outcome.approvalGrant?.approvalId, "approval_task_runner_preflight_1");
  assert.equal(outcome.approvalGrant?.grant.uses, 1);
  assert.deepEqual(outcome.connectorReceiptInput, {
    connector: "gmail",
    operation: "read",
    requestPayload: {
      query: "inbox"
    },
    responseMetadata: {
      endpoint: "https://example.com/api"
    },
    externalIds: ["thread_123"]
  });
});
