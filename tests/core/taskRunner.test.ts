import assert from "node:assert/strict";
import { test } from "node:test";

import { createBrainConfigFromEnv } from "../../src/core/config";
import { ALL_GOVERNOR_IDS, type GovernorId, type PlannedAction } from "../../src/core/types";
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

function createExecutionReceiptStoreAcceptingStub() {
  return {
    async appendApprovedActionReceipt() {
      return {
        receiptId: "receipt_1"
      };
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

function createApprovingGovernorsStub(): { id: GovernorId; evaluate: () => Promise<{
  governorId: GovernorId;
  approve: true;
  reason: string;
  confidence: number;
}> }[] {
  return ALL_GOVERNOR_IDS.filter((id) => id !== "codeReview").map((id) => ({
    id,
    async evaluate() {
      return {
        governorId: id,
        approve: true,
        reason: "approved for focused regression coverage",
        confidence: 1
      };
    }
  }));
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

test("TaskRunner rewrites same-plan preview proof actions onto the auto-rebound managed target", async () => {
  const config = createBrainConfigFromEnv({
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true"
  });
  const executedActions: { type: string; params: Record<string, unknown> }[] = [];
  const workspaceRoot = `${process.cwd()}\\runtime\\sandbox\\Foundry Echo`;
  const taskRunner = new TaskRunner({
    config,
    governors: createApprovingGovernorsStub() as never,
    masterGovernor: new MasterGovernor(7),
    modelClient: createModelClientStub(),
    executor: {
      prepare: async () => null,
      executeWithOutcome: async (action: PlannedAction) => {
        executedActions.push({
          type: action.type,
          params: { ...action.params }
        });
        if (action.type === "start_process") {
          return {
            status: "success",
            output: "preview started",
            executionMetadata: {
              managedProcess: true,
              processLifecycleStatus: "PROCESS_STARTED",
              processLeaseId: "lease_preview_foundry",
              processCwd: workspaceRoot,
              processRequestedHost: "127.0.0.1",
              processRequestedPort: 58327,
              processRequestedUrl: "http://127.0.0.1:58327",
              processLoopbackPortAutoRebound: true,
              processOriginalRequestedHost: "127.0.0.1",
              processOriginalRequestedPort: 4173,
              processOriginalRequestedUrl: "http://127.0.0.1:4173"
            }
          };
        }
        return {
          status: "success",
          output: `${action.type} ok`
        };
      },
      consumeShellExecutionTelemetry: () => null
    } as never,
    governanceMemoryStore: createGovernanceMemoryStoreStub() as never,
    executionReceiptStore: createExecutionReceiptStoreAcceptingStub() as never,
    appendTraceEvent: async () => undefined,
    stage686RuntimeActionEngine: {
      execute: async () => null
    } as never
  });

  const result = await taskRunner.runPlanActions({
    task: {
      id: "task_runner_preview_override",
      agentId: "main-agent",
      goal: "Create a static Foundry Echo landing page, open it, and leave it running.",
      userInput:
        "Create a static Foundry Echo landing page in the sandbox, open it in the browser, and use any free local port.",
      createdAt: "2026-04-12T23:30:00.000Z"
    },
    state: {} as never,
    plan: {
      taskId: "task_runner_preview_override",
      plannerNotes: "preview override regression",
      actions: [
        {
          id: "action_start_foundry_preview",
          type: "start_process",
          description: "start the local preview",
          params: {
            command: "python -m http.server 4173 --bind 127.0.0.1",
            cwd: workspaceRoot,
            workdir: workspaceRoot,
            requestedShellKind: config.shellRuntime.profile.shellKind,
            timeoutMs: 120000
          },
          estimatedCostUsd: 0.15
        },
        {
          id: "action_probe_foundry_preview",
          type: "probe_http",
          description: "prove the page is reachable",
          params: {
            url: "http://127.0.0.1:4173/index.html",
            timeoutMs: 12000
          },
          estimatedCostUsd: 0.02
        },
        {
          id: "action_open_foundry_preview",
          type: "open_browser",
          description: "open the local page in the browser",
          params: {
            url: "http://127.0.0.1:4173/index.html",
            previewProcessLeaseId: "none"
          },
          estimatedCostUsd: 0.03
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
  assert.equal(result.results.every((entry) => entry.approved), true);
  assert.equal(executedActions.length, 3);
  assert.equal(executedActions[1]?.type, "probe_http");
  assert.equal(
    executedActions[1]?.params.url,
    "http://127.0.0.1:58327/index.html"
  );
  assert.equal(executedActions[2]?.type, "open_browser");
  assert.equal(
    executedActions[2]?.params.url,
    "http://127.0.0.1:58327/index.html"
  );
  assert.equal(
    executedActions[2]?.params.previewProcessLeaseId,
    "lease_preview_foundry"
  );
  assert.equal(
    executedActions[2]?.params.rootPath,
    workspaceRoot
  );
});

test("TaskRunner rewrites same-task browser ownership onto the exact managed preview target even when planner hints are stale", async () => {
  const config = createBrainConfigFromEnv({
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true"
  });
  const executedActions: { type: string; params: Record<string, unknown> }[] = [];
  const foundryRoot = `${process.cwd()}\\runtime\\sandbox\\Foundry Echo`;
  const riverRoot = `${process.cwd()}\\runtime\\sandbox\\River Glass`;
  const taskRunner = new TaskRunner({
    config,
    governors: createApprovingGovernorsStub() as never,
    masterGovernor: new MasterGovernor(7),
    modelClient: createModelClientStub(),
    executor: {
      prepare: async () => null,
      executeWithOutcome: async (action: PlannedAction) => {
        executedActions.push({
          type: action.type,
          params: { ...action.params }
        });
        if (action.type === "start_process") {
          return {
            status: "success",
            output: "preview started",
            executionMetadata: {
              managedProcess: true,
              processLifecycleStatus: "PROCESS_STARTED",
              processLeaseId: "lease_preview_river",
              processCwd: riverRoot,
              processRequestedHost: "127.0.0.1",
              processRequestedPort: 61658,
              processRequestedUrl: "http://127.0.0.1:61658"
            }
          };
        }
        return {
          status: "success",
          output: `${action.type} ok`
        };
      },
      consumeShellExecutionTelemetry: () => null
    } as never,
    governanceMemoryStore: createGovernanceMemoryStoreStub() as never,
    executionReceiptStore: createExecutionReceiptStoreAcceptingStub() as never,
    appendTraceEvent: async () => undefined,
    stage686RuntimeActionEngine: {
      execute: async () => null
    } as never
  });

  const result = await taskRunner.runPlanActions({
    task: {
      id: "task_runner_same_task_preview_binding",
      agentId: "main-agent",
      goal: "Create a static River Glass landing page, open it, and leave it running.",
      userInput:
        "Create a static River Glass landing page, open it in the browser, and leave it running.",
      createdAt: "2026-04-13T06:35:00.000Z"
    },
    state: {} as never,
    plan: {
      taskId: "task_runner_same_task_preview_binding",
      plannerNotes: "same-task preview ownership regression",
      actions: [
        {
          id: "action_start_river_preview",
          type: "start_process",
          description: "start the local preview",
          params: {
            command: "python -m http.server 61658 --bind 127.0.0.1",
            cwd: riverRoot,
            workdir: riverRoot,
            requestedShellKind: config.shellRuntime.profile.shellKind,
            timeoutMs: 120000
          },
          estimatedCostUsd: 0.15
        },
        {
          id: "action_probe_river_preview",
          type: "probe_http",
          description: "prove the page is reachable",
          params: {
            url: "http://127.0.0.1:61658/index.html",
            timeoutMs: 12000
          },
          estimatedCostUsd: 0.02
        },
        {
          id: "action_open_river_preview",
          type: "open_browser",
          description: "open the local page in the browser",
          params: {
            url: "http://127.0.0.1:61658/index.html",
            previewProcessLeaseId: "lease_preview_foundry",
            rootPath: foundryRoot
          },
          estimatedCostUsd: 0.03
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
  assert.equal(result.results.every((entry) => entry.approved), true);
  assert.equal(executedActions.length, 3);
  assert.equal(executedActions[2]?.type, "open_browser");
  assert.equal(
    executedActions[2]?.params.url,
    "http://127.0.0.1:61658/index.html"
  );
  assert.equal(
    executedActions[2]?.params.previewProcessLeaseId,
    "lease_preview_river"
  );
  assert.equal(
    executedActions[2]?.params.rootPath,
    riverRoot
  );
});

test("TaskRunner rewrites inspect_workspace_resources onto the exact autonomous runtime target hint", async () => {
  const config = createBrainConfigFromEnv({
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true"
  });
  const executedActions: { type: string; params: Record<string, unknown> }[] = [];
  const taskRunner = new TaskRunner({
    config,
    governors: createApprovingGovernorsStub() as never,
    masterGovernor: new MasterGovernor(7),
    modelClient: createModelClientStub(),
    executor: {
      prepare: async () => null,
      executeWithOutcome: async (action: PlannedAction) => {
        executedActions.push({
          type: action.type,
          params: { ...action.params }
        });
        return {
          status: "success",
          output: `${action.type} ok`
        };
      },
      consumeShellExecutionTelemetry: () => null
    } as never,
    governanceMemoryStore: createGovernanceMemoryStoreStub() as never,
    executionReceiptStore: createExecutionReceiptStoreAcceptingStub() as never,
    appendTraceEvent: async () => undefined,
    stage686RuntimeActionEngine: {
      execute: async () => null
    } as never
  });

  const result = await taskRunner.runPlanActions({
    task: {
      id: "task_runner_runtime_inspection_hint",
      agentId: "main-agent",
      goal: "Verify that the tracked preview is shut down.",
      userInput: [
        'AUTONOMOUS_RUNTIME_INSPECTION_TARGET {"rootPath":"C:\\\\workspace\\\\Foundry Echo","previewUrl":"http://127.0.0.1:59570/","previewProcessLeaseId":"lease_preview_foundry"}',
        "Use inspect_workspace_resources first and stay on the exact tracked runtime."
      ].join("\n"),
      createdAt: "2026-04-13T08:00:00.000Z"
    },
    state: {} as never,
    plan: {
      taskId: "task_runner_runtime_inspection_hint",
      plannerNotes: "runtime inspection override regression",
      actions: [
        {
          id: "action_inspect_foundry_preview",
          type: "inspect_workspace_resources",
          description: "inspect the tracked preview stack",
          params: {
            rootPath: "C:\\Users\\testuser\\AppData\\Local\\Temp",
            previewUrl: "http://127.0.0.1:4173/",
            previewProcessLeaseId: "lease_preview_stale"
          },
          estimatedCostUsd: 0.02
        }
      ]
    } as never,
    missionAttemptId: 1,
    startedAtMs: Date.now(),
    cumulativeApprovedEstimatedCostUsd: 0,
    modelUsageStart: emptyUsageSnapshot(),
    profileMemoryStatus: {} as never
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.approved, true);
  assert.equal(executedActions.length, 1);
  assert.equal(executedActions[0]?.type, "inspect_workspace_resources");
  assert.equal(executedActions[0]?.params.rootPath, "C:\\workspace\\Foundry Echo");
  assert.equal(executedActions[0]?.params.previewUrl, "http://127.0.0.1:59570/");
  assert.equal(executedActions[0]?.params.previewProcessLeaseId, "lease_preview_foundry");
});
