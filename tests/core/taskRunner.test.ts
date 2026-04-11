import assert from "node:assert/strict";
import { test } from "node:test";

import { createBrainConfigFromEnv } from "../../src/core/config";
import { TaskRunner } from "../../src/core/taskRunner";
import { emptyUsageSnapshot } from "../../src/core/taskRunnerSupport";
import { MasterGovernor } from "../../src/governors/masterGovernor";
import type { ModelClient } from "../../src/models/types";

function createGovernanceMemoryStoreStub() {
  return {
    async appendEvent(input: Record<string, unknown>) {
      return {
        id: "gov_event_1",
        recordedAt: "2026-04-10T21:00:00.000Z",
        ...input
      };
    },
    async getReadView() {
      return {
        recent: [],
        blockersByActionType: {},
        blockersByGovernor: {},
        blockerRateByActionType: {},
        blockerRateByGovernor: {},
        approvedCount: 0,
        blockedCount: 0
      };
    }
  };
}

function createExecutionReceiptStoreStub() {
  return {
    async appendApprovedActionReceipt() {
      throw new Error("appendApprovedActionReceipt should not run in this preflight-block regression.");
    }
  };
}

function createModelClientStub(): ModelClient {
  return {
    backend: "mock",
    async completeJson() {
      throw new Error("completeJson should not run in this preflight-block regression.");
    },
    getUsageSnapshot: () => emptyUsageSnapshot()
  };
}

test("TaskRunner carries blocked framework install prerequisites forward before build and preview actions", async () => {
  const config = createBrainConfigFromEnv({});
  const taskRunner = new TaskRunner({
    config,
    governors: [],
    masterGovernor: new MasterGovernor(1),
    modelClient: createModelClientStub(),
    executor: {
      prepare: async () => null,
      executeWithOutcome: async () => {
        throw new Error("executor.executeWithOutcome should not run in this regression.");
      },
      consumeShellExecutionTelemetry: () => null
    } as never,
    governanceMemoryStore: createGovernanceMemoryStoreStub() as never,
    executionReceiptStore: createExecutionReceiptStoreStub() as never,
    appendTraceEvent: async () => undefined,
    stage686RuntimeActionEngine: {
      execute: async () => null
    } as never
  });

  const workspaceRoot = "C:\\Users\\testuser\\Desktop\\Detroit City";
  const result = await taskRunner.runPlanActions({
    task: {
      id: "task_runner_preflight_dependency_guard",
      agentId: "main-agent",
      goal: "Create the Detroit City landing page and leave it open.",
      userInput:
        'Create a Next.js landing page called "Detroit City" on my Desktop, run it, and leave it open in the browser.',
      createdAt: "2026-04-10T21:00:00.000Z"
    },
    state: {} as never,
    plan: {
      taskId: "task_runner_preflight_dependency_guard",
      plannerNotes: "deterministic fallback",
      actions: [
        {
          id: "action_install_invalid_timeout",
          type: "shell_command",
          description: "install dependencies",
          params: {
            command: "npm install",
            cwd: workspaceRoot,
            workdir: workspaceRoot,
            requestedShellKind: "powershell",
            timeoutMs: 240000
          },
          estimatedCostUsd: 0.25
        },
        {
          id: "action_build_after_install",
          type: "shell_command",
          description: "build the app",
          params: {
            command: "npm run build",
            cwd: workspaceRoot,
            workdir: workspaceRoot,
            requestedShellKind: "powershell",
            timeoutMs: 120000
          },
          estimatedCostUsd: 0.25
        },
        {
          id: "action_preview_after_install",
          type: "start_process",
          description: "start the local preview",
          params: {
            command: "npm run dev -- --hostname 127.0.0.1 --port 3000",
            cwd: workspaceRoot,
            workdir: workspaceRoot,
            requestedShellKind: "powershell",
            timeoutMs: 120000
          },
          estimatedCostUsd: 0.28
        }
      ]
    } as never,
    missionAttemptId: 1,
    startedAtMs: Date.now(),
    cumulativeApprovedEstimatedCostUsd: 0,
    modelUsageStart: emptyUsageSnapshot(),
    profileMemoryStatus: {} as never
  });

  assert.equal(result.results.length, 3);
  assert.equal(result.results[0]?.blockedBy.includes("SHELL_TIMEOUT_INVALID"), true);
  assert.deepEqual(result.results[1]?.blockedBy, ["ACTION_EXECUTION_FAILED"]);
  assert.deepEqual(result.results[2]?.blockedBy, ["ACTION_EXECUTION_FAILED"]);
  assert.match(
    result.results[1]?.output ?? "",
    /earlier framework workspace prerequisite failed/i
  );
  assert.match(
    result.results[2]?.output ?? "",
    /earlier framework workspace prerequisite failed/i
  );
  assert.equal(
    result.results[1]?.executionMetadata?.liveRunDependencyStage,
    "install"
  );
  assert.equal(
    result.results[2]?.executionMetadata?.liveRunDependencyStage,
    "install"
  );
});
