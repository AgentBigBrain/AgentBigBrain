/**
 * @fileoverview Tests canonical approved-action execution extracted into the orchestration subsystem.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { estimateActionCostUsd } from "../../src/core/actionCostPolicy";
import type { ShellExecutionTelemetry } from "../../src/organs/executionRuntime/contracts";
import {
  executeTaskRunnerAction,
  type ExecuteTaskRunnerActionInput
} from "../../src/core/orchestration/taskRunnerExecution";

const BASE_ACTION = {
  id: "action_task_runner_execution_1",
  type: "respond" as const,
  description: "respond to the user",
  params: {
    message: "done"
  },
  estimatedCostUsd: 0.01
};

function createExecutionInput(): {
  input: ExecuteTaskRunnerActionInput;
  shellTelemetry: ShellExecutionTelemetry;
  traceEvents: Array<{ eventType: string; details?: Record<string, unknown> }>;
} {
  const traceEvents: Array<{ eventType: string; details?: Record<string, unknown> }> = [];
  const shellTelemetry: ShellExecutionTelemetry = {
    shellKind: "bash",
    shellExecutable: "/bin/bash",
    shellProfileFingerprint: "profile_1",
    shellSpawnSpecFingerprint: "spawn_spec_1",
    shellTimeoutMs: 10_000,
    shellEnvMode: "isolated",
    shellEnvKeyCount: 0,
    shellEnvRedactedKeyCount: 0,
    shellExitCode: 0,
    shellSignal: null,
    shellTimedOut: false,
    shellStdoutDigest: "stdout_digest",
    shellStderrDigest: "stderr_digest",
    shellStdoutBytes: 0,
    shellStderrBytes: 0,
    shellStdoutTruncated: false,
    shellStderrTruncated: false
  };
  const input: ExecuteTaskRunnerActionInput = {
    action: BASE_ACTION,
    appendTraceEvent: async (event: {
      eventType: string;
      details?: Record<string, unknown>;
    }) => {
      traceEvents.push(event);
    },
    combinedVotes: [
      {
        governorId: "security",
        approve: true,
        reason: "Safe.",
        confidence: 1
      }
    ],
    connectorReceiptInput: null,
    decision: {
      approved: true,
      yesVotes: 1,
      noVotes: 0,
      threshold: 1,
      dissent: []
    },
    deterministicActionId: "deterministic_action_1",
    executor: {
      prepare: async () => null,
      executeWithOutcome: async () => ({
        status: "success" as const,
        output: "runtime output"
      }),
      consumeShellExecutionTelemetry: () => shellTelemetry
    },
    missionAttemptId: 1,
    missionPhase: "retrieve",
    mode: "fast_path" as const,
    proposalId: "proposal_task_runner_execution_1",
    stage686RuntimeActionEngine: {
      execute: async () => null
    },
    taskId: "task_task_runner_execution_1"
  };
  return {
    input,
    shellTelemetry,
    traceEvents
  };
}

test("executeTaskRunnerAction returns a blocked result when executor execution fails", async () => {
  const { input, traceEvents } = createExecutionInput();
  input.executor.executeWithOutcome = async () => ({
    status: "failed",
    output: "boom",
    failureCode: "ACTION_EXECUTION_FAILED",
    executionMetadata: {
      shellExitCode: 1
    }
  });

  const result = await executeTaskRunnerAction(input);

  assert.equal(result.actionResult.approved, false);
  assert.deepEqual(result.actionResult.blockedBy, ["ACTION_EXECUTION_FAILED"]);
  assert.equal(result.approvedEstimatedCostDeltaUsd, 0);
  assert.deepEqual(result.blockedTraceDetails, {
    blockCode: "ACTION_EXECUTION_FAILED",
    blockCategory: "runtime"
  });
  assert.equal(result.outputLength, 4);
  assert.deepEqual(traceEvents, []);
});

test("executeTaskRunnerAction returns approved metadata and trace details for prepared output", async () => {
  const { input, traceEvents } = createExecutionInput();
  input.executor.prepare = async () => "prepared output";
  input.executor.consumeShellExecutionTelemetry = () => null;
  input.connectorReceiptInput = {
    connector: "gmail",
    operation: "draft",
    requestPayload: {
      to: "person@example.com"
    },
    responseMetadata: {
      endpoint: "https://gmail.test/drafts"
    },
    externalIds: ["draft_123"]
  };

  const result = await executeTaskRunnerAction(input);

  assert.equal(result.actionResult.approved, true);
  assert.equal(result.actionResult.output, "prepared output");
  assert.equal(
    result.approvedEstimatedCostDeltaUsd,
    estimateActionCostUsd({
      type: input.action.type,
      params: input.action.params
    })
  );
  assert.equal(result.outputLength, "prepared output".length);
  assert.equal(traceEvents.length, 1);
  assert.equal(traceEvents[0]?.eventType, "action_executed");
  assert.equal(traceEvents[0]?.details?.usedPreparedOutput, true);
  assert.equal(traceEvents[0]?.details?.connector, "gmail");
  assert.equal(
    result.actionResult.executionMetadata?.stage675Connector,
    "gmail"
  );
  assert.equal(
    result.actionResult.executionMetadata?.stage675ConnectorOperation,
    "draft"
  );
  assert.equal(result.actionResult.executionMetadata?.missionAttemptId, 1);
  assert.equal(result.actionResult.executionMetadata?.missionPhase, "retrieve");
  assert.equal(
    result.actionResult.executionMetadata?.deterministicActionId,
    "deterministic_action_1"
  );
});
