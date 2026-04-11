/**
 * @fileoverview Tests managed-process lease tracking and cleanup helpers extracted from the autonomous loop.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cleanupManagedProcessLease,
  findApprovedManagedProcessCheckResult,
  findApprovedManagedProcessStartContext,
  findApprovedManagedProcessStartLeaseId,
  resolveTrackedManagedProcessLeaseId,
  resolveTrackedManagedProcessStartContext
} from "../../src/core/autonomy/loopCleanupPolicy";
import { BrainOrchestrator } from "../../src/core/orchestrator";
import { type ActionRunResult, type TaskRequest, type TaskRunResult } from "../../src/core/types";

function buildTaskResult(actionResults: ActionRunResult[]): TaskRunResult {
  return {
    task: {
      id: "task_loop_cleanup_policy",
      goal: "test",
      userInput: "test",
      createdAt: new Date().toISOString()
    },
    plan: {
      taskId: "task_loop_cleanup_policy",
      plannerNotes: "stub",
      actions: actionResults.map((entry) => entry.action)
    },
    actionResults,
    summary: "stub summary",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  };
}

function buildApprovedStartProcessResult(
  actionId: string,
  leaseId = "proc_cleanup_policy_1"
): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "start_process",
      description: "start the local server",
      params: {
        command: "python -m http.server 8125",
        cwd: "runtime/generated"
      },
      estimatedCostUsd: 0.28
    },
    mode: "escalation_path",
    approved: true,
    output: `Process started: lease ${leaseId}.`,
    executionStatus: "success",
    executionMetadata: {
      processLeaseId: leaseId,
      processLifecycleStatus: "PROCESS_STARTED"
    },
    blockedBy: [],
    violations: [],
    votes: []
  };
}

function buildApprovedCheckProcessResult(
  actionId: string,
  leaseId = "proc_cleanup_policy_1",
  lifecycleStatus = "PROCESS_STILL_RUNNING"
): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "check_process",
      description: "check the managed process",
      params: {
        leaseId
      },
      estimatedCostUsd: 0.04
    },
    mode: "fast_path",
    approved: true,
    output: `Process status: ${lifecycleStatus}.`,
    executionStatus: "success",
    executionMetadata: {
      processLeaseId: leaseId,
      processLifecycleStatus: lifecycleStatus
    },
    blockedBy: [],
    violations: [],
    votes: []
  };
}

function buildApprovedStopProcessResult(
  actionId: string,
  leaseId = "proc_cleanup_policy_1"
): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "stop_process",
      description: "stop the managed process",
      params: {
        leaseId
      },
      estimatedCostUsd: 0.04
    },
    mode: "fast_path",
    approved: true,
    output: `Process stopped: lease ${leaseId}.`,
    executionStatus: "success",
    executionMetadata: {
      processLeaseId: leaseId,
      processLifecycleStatus: "PROCESS_STOPPED"
    },
    blockedBy: [],
    violations: [],
    votes: []
  };
}

class CleanupStubOrchestrator {
  public readonly receivedTasks: TaskRequest[] = [];

  async runTask(task: TaskRequest): Promise<TaskRunResult> {
    this.receivedTasks.push(task);
    return {
      task,
      plan: {
        taskId: task.id,
        plannerNotes: "cleanup stub",
        actions: []
      },
      actionResults: [],
      summary: "cleanup complete",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    };
  }
}

test("lease helpers recover start and check metadata deterministically", () => {
  const startResult = buildTaskResult([
    buildApprovedStartProcessResult("start_process_cleanup_1", "proc_cleanup_policy_1")
  ]);
  const checkResult = buildTaskResult([
    buildApprovedCheckProcessResult(
      "check_process_cleanup_1",
      "proc_cleanup_policy_1",
      "PROCESS_STILL_RUNNING"
    )
  ]);

  assert.equal(findApprovedManagedProcessStartLeaseId(startResult), "proc_cleanup_policy_1");
  assert.deepEqual(findApprovedManagedProcessStartContext(startResult), {
    leaseId: "proc_cleanup_policy_1",
    command: "python -m http.server 8125",
    cwd: "runtime/generated"
  });
  assert.deepEqual(findApprovedManagedProcessCheckResult(checkResult), {
    leaseId: "proc_cleanup_policy_1",
    lifecycleStatus: "PROCESS_STILL_RUNNING"
  });
});

test("tracked lease ids survive checks and clear after stop-proof results", () => {
  const trackedAfterStart = resolveTrackedManagedProcessLeaseId(
    null,
    buildTaskResult([buildApprovedStartProcessResult("start_process_cleanup_2", "proc_cleanup_policy_2")])
  );
  const trackedAfterCheck = resolveTrackedManagedProcessLeaseId(
    trackedAfterStart,
    buildTaskResult([
      buildApprovedCheckProcessResult(
        "check_process_cleanup_2",
        "proc_cleanup_policy_2",
        "PROCESS_STILL_RUNNING"
      )
    ])
  );
  const trackedAfterStop = resolveTrackedManagedProcessLeaseId(
    trackedAfterCheck,
    buildTaskResult([buildApprovedStopProcessResult("stop_process_cleanup_2", "proc_cleanup_policy_2")])
  );

  assert.equal(trackedAfterStart, "proc_cleanup_policy_2");
  assert.equal(trackedAfterCheck, "proc_cleanup_policy_2");
  assert.equal(trackedAfterStop, null);
});

test("tracked start context survives later check_process iterations", () => {
  const trackedAfterStart = resolveTrackedManagedProcessStartContext(
    null,
    buildTaskResult([buildApprovedStartProcessResult("start_process_cleanup_3", "proc_cleanup_policy_3")])
  );
  const trackedAfterCheck = resolveTrackedManagedProcessStartContext(
    trackedAfterStart,
    buildTaskResult([
      buildApprovedCheckProcessResult(
        "check_process_cleanup_3",
        "proc_cleanup_policy_3",
        "PROCESS_STOPPED"
      )
    ])
  );

  assert.deepEqual(trackedAfterStart, {
    leaseId: "proc_cleanup_policy_3",
    command: "python -m http.server 8125",
    cwd: "runtime/generated"
  });
  assert.deepEqual(trackedAfterCheck, trackedAfterStart);
});

test("cleanupManagedProcessLease issues one bounded stop_process task", async () => {
  const orchestrator = new CleanupStubOrchestrator();

  await cleanupManagedProcessLease(
    orchestrator as unknown as BrainOrchestrator,
    "Run the local app and verify the UI.",
    "proc_cleanup_policy_3"
  );

  assert.equal(orchestrator.receivedTasks.length, 1);
  assert.match(
    orchestrator.receivedTasks[0]?.userInput ?? "",
    /^stop_process leaseId="proc_cleanup_policy_3"/i
  );
  assert.equal(orchestrator.receivedTasks[0]?.goal, "Run the local app and verify the UI.");
});
