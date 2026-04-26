/**
 * @fileoverview Tests task-runner lifecycle bookkeeping extracted into the orchestration subsystem.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildTaskRunnerMissionStopLimits,
  recordApprovedActionOutcome,
  recordBlockedActionOutcome
} from "../../src/core/orchestration/taskRunnerLifecycle";
import {
  buildApprovedActionResult,
  buildBlockedActionResult
} from "../../src/core/orchestration/taskRunnerSummary";
import { buildInitialMissionState } from "../../src/core/stage6_75MissionStateMachine";
import { type ActionRunResult, type GovernanceMemoryEvent } from "../../src/core/types";

function createGovernanceMemoryStoreStub() {
  const events: GovernanceMemoryEvent[] = [];
  return {
    events,
    store: {
      appendEvent: async (input: {
        taskId: string;
        proposalId: string | null;
        actionId: string;
        actionType: GovernanceMemoryEvent["actionType"];
        mode: GovernanceMemoryEvent["mode"];
        outcome: GovernanceMemoryEvent["outcome"];
        blockCategory: GovernanceMemoryEvent["blockCategory"];
        blockedBy: GovernanceMemoryEvent["blockedBy"];
        violationCodes: GovernanceMemoryEvent["violationCodes"];
        yesVotes: number;
        noVotes: number;
        threshold: number | null;
        dissentGovernorIds: GovernanceMemoryEvent["dissentGovernorIds"];
      }): Promise<GovernanceMemoryEvent> => {
        const event: GovernanceMemoryEvent = {
          id: `gov_event_${events.length + 1}`,
          recordedAt: "2026-03-07T12:00:00.000Z",
          ...input
        };
        events.push(event);
        return event;
      }
    }
  };
}

function createExecutionReceiptStoreStub() {
  const receipts: Array<{
    taskId: string;
    planTaskId: string;
    proposalId: string | null;
    actionId: string;
  }> = [];
  return {
    receipts,
    store: {
      appendApprovedActionReceipt: async (input: {
        taskId: string;
        planTaskId: string;
        proposalId: string | null;
        actionResult: { action: { id: string } };
      }) => {
        receipts.push({
          taskId: input.taskId,
          planTaskId: input.planTaskId,
          proposalId: input.proposalId,
          actionId: input.actionResult.action.id
        });
      }
    }
  };
}

test("buildTaskRunnerMissionStopLimits derives deterministic limits from config", () => {
  const limits = buildTaskRunnerMissionStopLimits({
    limits: {
      maxActionsPerTask: 4,
      maxPlanAttemptsPerTask: 3
    }
  } as never, {
    taskId: "task_runner_lifecycle_limits",
    plannerNotes: "generic plan",
    actions: []
  } as never);

  assert.deepEqual(limits, {
    maxActions: 4,
    maxDenies: 6,
    maxBytes: 1_048_576
  });
});

test("buildTaskRunnerMissionStopLimits keeps the configured action cap for stale deterministic framework lifecycle notes", () => {
  const limits = buildTaskRunnerMissionStopLimits({
    limits: {
      maxActionsPerTask: 8,
      maxPlanAttemptsPerTask: 2
    }
  } as never, {
    taskId: "task_runner_lifecycle_framework_limits",
    plannerNotes:
      "Deterministic framework build lifecycle fallback " +
      "(deterministic_framework_build_fallback=shell_command)",
    actions: [
      {
        id: "action_1",
        type: "shell_command",
        description: "scaffold",
        params: {},
        estimatedCostUsd: 0.01
      },
      {
        id: "action_2",
        type: "write_file",
        description: "layout",
        params: {},
        estimatedCostUsd: 0.01
      },
      {
        id: "action_3",
        type: "write_file",
        description: "page",
        params: {},
        estimatedCostUsd: 0.01
      },
      {
        id: "action_4",
        type: "write_file",
        description: "styles",
        params: {},
        estimatedCostUsd: 0.01
      },
      {
        id: "action_5",
        type: "shell_command",
        description: "install",
        params: {},
        estimatedCostUsd: 0.01
      },
      {
        id: "action_6",
        type: "shell_command",
        description: "workspace proof",
        params: {},
        estimatedCostUsd: 0.01
      },
      {
        id: "action_7",
        type: "shell_command",
        description: "build",
        params: {},
        estimatedCostUsd: 0.01
      },
      {
        id: "action_8",
        type: "shell_command",
        description: "build proof",
        params: {},
        estimatedCostUsd: 0.01
      },
      {
        id: "action_9",
        type: "start_process",
        description: "start",
        params: {},
        estimatedCostUsd: 0.01
      },
      {
        id: "action_10",
        type: "probe_http",
        description: "probe",
        params: {},
        estimatedCostUsd: 0.01
      },
      {
        id: "action_11",
        type: "verify_browser",
        description: "verify",
        params: {},
        estimatedCostUsd: 0.01
      },
      {
        id: "action_12",
        type: "open_browser",
        description: "open",
        params: {},
        estimatedCostUsd: 0.01
      }
    ]
  } as never);

  assert.deepEqual(limits, {
    maxActions: 8,
    maxDenies: 4,
    maxBytes: 1_048_576
  });
});

test("recordBlockedActionOutcome appends telemetry, governance memory, and denied mission state", async () => {
  const traces: Array<{ eventType: string }> = [];
  const governance = createGovernanceMemoryStoreStub();
  const attemptResults: ActionRunResult[] = [];
  const nextState = await recordBlockedActionOutcome({
    actionResult: buildBlockedActionResult({
      action: {
        id: "blocked_action_1",
        type: "respond",
        description: "blocked respond",
        params: {},
        estimatedCostUsd: 0.01
      },
      mode: "fast_path",
      blockedBy: ["VERIFICATION_GATE_FAILED"],
      violations: [
        {
          code: "VERIFICATION_GATE_FAILED",
          message: "Verification gate failed."
        }
      ]
    }),
    appendTraceEvent: async (input) => {
      traces.push({ eventType: input.eventType });
    },
    attemptResults,
    governanceMemoryStore: governance.store as never,
    idempotencyKey: "task:1:blocked_action_1",
    missionState: buildInitialMissionState("task_lifecycle", 1),
    proposalId: "proposal_1",
    taskId: "task_lifecycle",
    traceDetails: {
      blockCode: "VERIFICATION_GATE_FAILED",
      blockCategory: "constraints"
    }
  });

  assert.equal(attemptResults.length, 1);
  assert.equal(governance.events.length, 1);
  assert.deepEqual(
    traces.map((entry) => entry.eventType),
    ["constraint_blocked", "governance_event_persisted"]
  );
  assert.equal(nextState.actionCount, 1);
  assert.equal(nextState.denyCount, 1);
  assert.equal(nextState.currentPhase, "retrieve");
});

test("recordApprovedActionOutcome appends receipts and advances mission state without deny count", async () => {
  const traces: Array<{ eventType: string }> = [];
  const governance = createGovernanceMemoryStoreStub();
  const receipts = createExecutionReceiptStoreStub();
  const attemptResults: ActionRunResult[] = [];
  const nextState = await recordApprovedActionOutcome({
    actionResult: buildApprovedActionResult({
      action: {
        id: "approved_action_1",
        type: "respond",
        description: "approved respond",
        params: {},
        estimatedCostUsd: 0.01
      },
      mode: "fast_path",
      output: "done",
      executionStatus: "success"
    }),
    appendTraceEvent: async (input) => {
      traces.push({ eventType: input.eventType });
    },
    attemptResults,
    executionReceiptStore: receipts.store as never,
    governanceMemoryStore: governance.store as never,
    idempotencyKey: "task:1:approved_action_1",
    missionState: buildInitialMissionState("task_lifecycle", 1),
    outputLength: 4,
    planTaskId: "task_lifecycle",
    proposalId: "proposal_2",
    taskId: "task_lifecycle"
  });

  assert.equal(attemptResults.length, 1);
  assert.equal(governance.events.length, 1);
  assert.equal(receipts.receipts.length, 1);
  assert.deepEqual(
    traces.map((entry) => entry.eventType),
    ["governance_event_persisted"]
  );
  assert.equal(nextState.actionCount, 1);
  assert.equal(nextState.denyCount, 0);
  assert.equal(nextState.bytesObserved, 4);
  assert.equal(nextState.currentPhase, "retrieve");
});
