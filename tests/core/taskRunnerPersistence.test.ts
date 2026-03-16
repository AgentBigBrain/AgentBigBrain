/**
 * @fileoverview Tests canonical task-runner governance-event and receipt persistence helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AppendRuntimeTraceEventInput } from "../../src/core/runtimeTraceLogger";
import {
  appendExecutionReceipt,
  appendGovernanceEvent,
  resolveBlockCategory
} from "../../src/core/orchestration/taskRunnerPersistence";

test("resolveBlockCategory prefers runtime for execution failures", () => {
  const category = resolveBlockCategory({
    action: {
      id: "action_task_runner_persistence_1",
      type: "shell_command",
      description: "run command",
      params: {},
      estimatedCostUsd: 0.01
    },
    mode: "escalation_path",
    approved: false,
    blockedBy: ["ACTION_EXECUTION_FAILED"],
    violations: [
      {
        code: "ACTION_EXECUTION_FAILED",
        message: "command failed"
      }
    ],
    votes: []
  });

  assert.equal(category, "runtime");
});

test("appendGovernanceEvent persists aligned vote and trace details", async () => {
  const appendedEvents: Array<Record<string, unknown>> = [];
  const traceEvents: Array<Record<string, unknown>> = [];
  const governanceEvent = await appendGovernanceEvent({
    taskId: "task_task_runner_persistence_2",
    proposalId: "proposal_task_runner_persistence_2",
    actionResult: {
      action: {
        id: "action_task_runner_persistence_2",
        type: "respond",
        description: "respond",
        params: {},
        estimatedCostUsd: 0.01
      },
      mode: "fast_path",
      approved: false,
      blockedBy: ["security"],
      violations: [],
      votes: [
        {
          governorId: "security",
          approve: false,
          reason: "unsafe",
          confidence: 1
        }
      ]
    },
    governanceMemoryStore: {
      appendEvent: async (event: Record<string, unknown>) => {
        appendedEvents.push(event);
        return {
          id: "governance_event_1",
          ...event
        };
      }
    } as never,
    appendTraceEvent: async (event: AppendRuntimeTraceEventInput) => {
      traceEvents.push(event as unknown as Record<string, unknown>);
    }
  });

  assert.equal(governanceEvent.id, "governance_event_1");
  assert.equal(appendedEvents[0]?.blockCategory, "governance");
  assert.equal(appendedEvents[0]?.noVotes, 1);
  assert.equal(traceEvents[0]?.eventType, "governance_event_persisted");
});

test("appendExecutionReceipt skips blocked results and writes approved receipts", async () => {
  let receiptWrites = 0;
  const executionReceiptStore = {
    appendApprovedActionReceipt: async () => {
      receiptWrites += 1;
      return {} as never;
    }
  };

  await appendExecutionReceipt({
    taskId: "task_task_runner_persistence_3",
    planTaskId: "plan_task_runner_persistence_3",
    proposalId: "proposal_task_runner_persistence_3",
    actionResult: {
      action: {
        id: "action_task_runner_persistence_3a",
        type: "respond",
        description: "respond",
        params: {},
        estimatedCostUsd: 0.01
      },
      mode: "fast_path",
      approved: false,
      blockedBy: ["security"],
      violations: [],
      votes: []
    },
    executionReceiptStore: executionReceiptStore as never
  });
  await appendExecutionReceipt({
    taskId: "task_task_runner_persistence_3",
    planTaskId: "plan_task_runner_persistence_3",
    proposalId: "proposal_task_runner_persistence_3",
    actionResult: {
      action: {
        id: "action_task_runner_persistence_3b",
        type: "respond",
        description: "respond",
        params: {},
        estimatedCostUsd: 0.01
      },
      mode: "fast_path",
      approved: true,
      blockedBy: [],
      violations: [],
      votes: []
    },
    executionReceiptStore: executionReceiptStore as never
  });

  assert.equal(receiptWrites, 1);
});
