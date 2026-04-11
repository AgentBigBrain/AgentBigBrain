/**
 * @fileoverview Tests autonomous-loop control flow for non-daemon iterative execution.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_BRAIN_CONFIG } from "../../src/core/config";
import { AutonomousLoop } from "../../src/core/agentLoop";
import { BrainOrchestrator } from "../../src/core/orchestrator";
import { createAbortError } from "../../src/core/runtimeAbort";
import { ActionRunResult, TaskRequest, TaskRunResult } from "../../src/core/types";
import {
  AutonomousNextStepModelOutput,
  ModelClient,
  ProactiveGoalModelOutput,
  StructuredCompletionRequest
} from "../../src/models/types";
import {
  WINDOWS_TEST_ROBINHOOD_MOCK_DIR,
  WINDOWS_TEST_WRONG_APP_DIR
} from "../support/windowsPathFixtures";

class StubOrchestrator {
  public runCount = 0;

  /**
   * Implements `runTask` behavior within class StubOrchestrator.
   * Interacts with local collaborators through imported modules and typed inputs/outputs.
   */
  async runTask(task: TaskRequest, _options?: { signal?: AbortSignal }): Promise<TaskRunResult> {
    this.runCount += 1;
    return {
      task,
      plan: {
        taskId: task.id,
        plannerNotes: "stub",
        actions: []
      },
      actionResults: [],
      summary: `stub summary #${this.runCount}`,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    };
  }
}

class ScriptedOrchestrator extends StubOrchestrator {
  public readonly receivedInputs: string[] = [];

  /**
   * Initializes class ScriptedOrchestrator dependencies and runtime state.
   * Interacts with local collaborators through imported modules and typed inputs/outputs.
   */
  constructor(private readonly scriptedActionResults: ActionRunResult[][]) {
    super();
  }

  /**
   * Implements `runTask` behavior within class ScriptedOrchestrator.
   * Interacts with local collaborators through imported modules and typed inputs/outputs.
   */
  override async runTask(
    task: TaskRequest,
    _options?: { signal?: AbortSignal }
  ): Promise<TaskRunResult> {
    this.runCount += 1;
    this.receivedInputs.push(task.userInput);
    const actionResults =
      this.scriptedActionResults[this.runCount - 1] ?? this.scriptedActionResults[this.scriptedActionResults.length - 1] ?? [];
    return {
      task,
      plan: {
        taskId: task.id,
        plannerNotes: "stub",
        actions: actionResults.map((entry) => entry.action)
      },
      actionResults,
      summary: `stub summary #${this.runCount}`,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    };
  }
}

class ThrowingOrchestrator extends StubOrchestrator {
  /**
   * Implements `runTask` behavior within class ThrowingOrchestrator.
   * Interacts with local collaborators through imported modules and typed inputs/outputs.
   */
  override async runTask(
    _task: TaskRequest,
    _options?: { signal?: AbortSignal }
  ): Promise<TaskRunResult> {
    this.runCount += 1;
    throw new Error("OpenAI request timed out after 15000ms.");
  }
}

class AbortAwareOrchestrator extends StubOrchestrator {
  private resolveStarted: (() => void) | null = null;

  public readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });

  override async runTask(
    _task: TaskRequest,
    options?: { signal?: AbortSignal }
  ): Promise<TaskRunResult> {
    this.runCount += 1;
    this.resolveStarted?.();
    this.resolveStarted = null;
    return new Promise((_resolve, reject) => {
      if (options?.signal?.aborted) {
        reject(createAbortError());
        return;
      }
      options?.signal?.addEventListener(
        "abort",
        () => {
          reject(createAbortError());
        },
        { once: true }
      );
    });
  }
}

/**
 * Implements `buildApprovedRespondResult` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildApprovedRespondResult(actionId: string): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "respond",
      description: "reply",
      params: {
        message: "Acknowledged."
      },
      estimatedCostUsd: 0.01
    },
    mode: "fast_path",
    approved: true,
    output: "Acknowledged.",
    blockedBy: [],
    violations: [],
    votes: []
  };
}

/**
 * Implements `buildApprovedWriteFileResult` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildApprovedWriteFileResult(actionId: string): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "write_file",
      description: "write app scaffold file",
      params: {
        path: "runtime/generated/app.txt",
        content: "app scaffold"
      },
      estimatedCostUsd: 0.1
    },
    mode: "escalation_path",
    approved: true,
    output: "Write success: runtime/generated/app.txt (12 chars)",
    blockedBy: [],
    violations: [],
    votes: []
  };
}

/**
 * Implements `buildApprovedReadFileResult` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildApprovedReadFileResult(actionId: string): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "read_file",
      description: "read generated file",
      params: {
        path: "runtime/generated/app.txt"
      },
      estimatedCostUsd: 0.01
    },
    mode: "fast_path",
    approved: true,
    output: "Read success: runtime/generated/app.txt (120 chars).",
    executionStatus: "success",
    blockedBy: [],
    violations: [],
    votes: []
  };
}

/**
 * Implements `buildApprovedSimulatedShellResult` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildApprovedSimulatedShellResult(actionId: string): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "shell_command",
      description: "run shell scaffolding command",
      params: {
        command: "npm create vite@latest finance-dashboard"
      },
      estimatedCostUsd: 0.03
    },
    mode: "escalation_path",
    approved: true,
    output: "Shell execution simulated (real shell execution disabled by policy).",
    executionStatus: "success",
    executionMetadata: {
      simulatedExecution: true,
      simulatedExecutionReason: "SHELL_POLICY_DISABLED"
    },
    blockedBy: [],
    violations: [],
    votes: []
  };
}

/**
 * Implements `buildApprovedProbePortReadyResult` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildApprovedProbePortReadyResult(
  actionId: string,
  host = "127.0.0.1",
  port = 3000
): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "probe_port",
      description: "probe localhost readiness",
      params: {
        host,
        port
      },
      estimatedCostUsd: 0.03
    },
    mode: "escalation_path",
    approved: true,
    output: `Port ready: ${host}:${port} accepted a TCP connection.`,
    executionStatus: "success",
    executionMetadata: {
      readinessProbe: true,
      probeKind: "port",
      probeReady: true,
      processLifecycleStatus: "PROCESS_READY",
      probeHost: host,
      probePort: port
    },
    blockedBy: [],
    violations: [],
    votes: []
  };
}

/**
 * Implements `buildApprovedProbeHttpReadyResult` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildApprovedProbeHttpReadyResult(
  actionId: string,
  url = "http://127.0.0.1:3000/"
): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "probe_http",
      description: "probe localhost readiness",
      params: {
        url,
        expectedStatus: 200
      },
      estimatedCostUsd: 0.04
    },
    mode: "escalation_path",
    approved: true,
    output: `HTTP probe ready: ${url} returned 200.`,
    executionStatus: "success",
    executionMetadata: {
      readinessProbe: true,
      probeKind: "http",
      probeReady: true,
      processLifecycleStatus: "PROCESS_READY",
      probeUrl: url,
      probeExpectedStatus: 200,
      probeObservedStatus: 200
    },
    blockedBy: [],
    violations: [],
    votes: []
  };
}

/**
 * Implements `buildBlockedProbeHttpNotReadyResult` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildBlockedProbeHttpNotReadyResult(
  actionId: string,
  url = "http://127.0.0.1:3000/"
): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "probe_http",
      description: "probe localhost readiness",
      params: {
        url,
        expectedStatus: 200
      },
      estimatedCostUsd: 0.04
    },
    mode: "escalation_path",
    approved: false,
    output: `HTTP probe not ready: ${url} returned no HTTP response within 5000ms.`,
    executionStatus: "failed",
    executionFailureCode: "PROCESS_NOT_READY",
    executionMetadata: {
      probeKind: "http",
      probeReady: false,
      processLifecycleStatus: "PROCESS_NOT_READY",
      probeUrl: url
    },
    blockedBy: ["PROCESS_NOT_READY"],
    violations: [
      {
        code: "PROCESS_NOT_READY",
        message: "HTTP probe did not receive a ready response from localhost."
      }
    ],
    votes: []
  };
}

/**
 * Implements `buildApprovedStartProcessResult` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildApprovedStartProcessResult(
  actionId: string,
  leaseId = "proc_loop_live_1",
  command = "python -m http.server 3000",
  loopbackTarget?: {
    host: string;
    port: number;
    url: string;
  }
): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "start_process",
      description: "start the local server",
      params: {
        command,
        cwd: "runtime/generated"
      },
      estimatedCostUsd: 0.28
    },
    mode: "escalation_path",
    approved: true,
    output: `Process started: lease ${leaseId} (pid 4242).`,
    executionStatus: "success",
    executionMetadata: {
      processLeaseId: leaseId,
      processLifecycleStatus: "PROCESS_STARTED",
      processPid: 4242,
      processRequestedHost: loopbackTarget?.host,
      processRequestedPort: loopbackTarget?.port,
      processRequestedUrl: loopbackTarget?.url
    },
    blockedBy: [],
    violations: [],
    votes: []
  };
}

/**
 * Implements `buildApprovedCheckProcessStillRunningResult` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildApprovedCheckProcessStillRunningResult(
  actionId: string,
  leaseId = "proc_loop_live_1"
): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "check_process",
      description: "check the managed process lease",
      params: {
        leaseId
      },
      estimatedCostUsd: 0.04
    },
    mode: "fast_path",
    approved: true,
    output: `Process still running: lease ${leaseId} (pid 4242).`,
    executionStatus: "success",
    executionMetadata: {
      processLeaseId: leaseId,
      processLifecycleStatus: "PROCESS_STILL_RUNNING",
      processPid: 4242
    },
    blockedBy: [],
    violations: [],
    votes: []
  };
}

/**
 * Implements `buildApprovedStopProcessResult` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildApprovedStopProcessResult(
  actionId: string,
  leaseId = "proc_loop_live_1"
): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "stop_process",
      description: "stop the managed process lease",
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
      processLifecycleStatus: "PROCESS_STOPPED",
      processPid: 4242,
      processStopRequested: true
    },
    blockedBy: [],
    violations: [],
    votes: []
  };
}

/**
 * Implements `buildApprovedVerifyBrowserResult` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildApprovedVerifyBrowserResult(actionId: string): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "verify_browser",
      description: "verify homepage UI in browser",
      params: {
        url: "http://127.0.0.1:3000/",
        expectedTitle: "Finance"
      },
      estimatedCostUsd: 0.09
    },
    mode: "escalation_path",
    approved: true,
    output: "Browser verification passed: observed title \"Finance Dashboard\"; expected title matched.",
    executionStatus: "success",
    executionMetadata: {
      browserVerification: true,
      browserVerifyPassed: true,
      browserVerifyUrl: "http://127.0.0.1:3000/",
      browserVerifyObservedTitle: "Finance Dashboard",
      browserVerifyMatchedTitle: true,
      browserVerifyExpectedTitle: "Finance",
      processLifecycleStatus: "PROCESS_READY"
    },
    blockedBy: [],
    violations: [],
    votes: []
  };
}

/**
 * Implements `buildBlockedVerifyBrowserRuntimeUnavailableResult` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildBlockedVerifyBrowserRuntimeUnavailableResult(actionId: string): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "verify_browser",
      description: "verify homepage UI in browser",
      params: {
        url: "http://127.0.0.1:3000/",
        expectedTitle: "Playwright Proof Smoke",
        expectedText: "Browser proof works"
      },
      estimatedCostUsd: 0.08
    },
    mode: "escalation_path",
    approved: false,
    output: "Browser verification is unavailable in this runtime because Playwright is not installed locally.",
    executionStatus: "failed",
    executionFailureCode: "BROWSER_VERIFY_RUNTIME_UNAVAILABLE",
    executionMetadata: {
      browserVerification: true,
      browserVerifyPassed: false
    },
    blockedBy: ["BROWSER_VERIFY_RUNTIME_UNAVAILABLE"],
    violations: [
      {
        code: "BROWSER_VERIFY_RUNTIME_UNAVAILABLE",
        message: "Browser verification is unavailable in this runtime because Playwright is not installed locally."
      }
    ],
    votes: []
  };
}

/**
 * Implements `buildBlockedProbeHttpGovernanceResult` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildBlockedProbeHttpGovernanceResult(actionId: string): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "probe_http",
      description: "probe localhost readiness",
      params: {
        url: "http://127.0.0.1:3000/"
      },
      estimatedCostUsd: 0.03
    },
    mode: "escalation_path",
    approved: false,
    output: "Probe blocked by governor policy.",
    executionStatus: "blocked",
    blockedBy: ["resource", "continuity", "utility"],
    violations: [],
    votes: []
  };
}

/**
 * Implements `buildBlockedStartProcessEthicsSecurityResult` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildBlockedStartProcessEthicsSecurityResult(actionId: string): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "start_process",
      description: "start the local server",
      params: {
        command: "python -m http.server 3000",
        cwd: "runtime/generated"
      },
      estimatedCostUsd: 0.28
    },
    mode: "escalation_path",
    approved: false,
    output: "Process start blocked by governor policy.",
    executionStatus: "blocked",
    blockedBy: ["ethics", "security"],
    violations: [],
    votes: []
  };
}

/**
 * Implements `buildBlockedStartProcessPortInUseResult` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildBlockedStartProcessPortInUseResult(
  actionId: string,
  requestedPort = 8000,
  suggestedPort = 8125
): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "start_process",
      description: "start the local server",
      params: {
        command: `python -m http.server ${requestedPort}`,
        cwd: "runtime/generated"
      },
      estimatedCostUsd: 0.28
    },
    mode: "escalation_path",
    approved: false,
    output:
      `Process start failed: http://localhost:${requestedPort} was already occupied before startup. ` +
      `Try a different free loopback port such as ${suggestedPort}.`,
    executionStatus: "failed",
    executionFailureCode: "PROCESS_START_FAILED",
    executionMetadata: {
      managedProcess: true,
      processLifecycleStatus: "PROCESS_START_FAILED",
      processStartupFailureKind: "PORT_IN_USE",
      processRequestedHost: "localhost",
      processRequestedPort: requestedPort,
      processRequestedUrl: `http://localhost:${requestedPort}`,
      processSuggestedHost: "localhost",
      processSuggestedPort: suggestedPort,
      processSuggestedUrl: `http://localhost:${suggestedPort}`,
      processCwd: "runtime/generated"
    },
    blockedBy: ["PROCESS_START_FAILED"],
    violations: [
      {
        code: "PROCESS_START_FAILED",
        message: `Process start failed because localhost:${requestedPort} was already occupied.`
      }
    ],
    votes: []
  };
}

/**
 * Implements `buildApprovedShellResult` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildApprovedShellResult(actionId: string, command: string): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "shell_command",
      description: "execute shell command",
      params: {
        command
      },
      estimatedCostUsd: 0.08
    },
    mode: "escalation_path",
    approved: true,
    output: `Shell command completed: ${command}`,
    executionStatus: "success",
    blockedBy: [],
    violations: [],
    votes: []
  };
}

/**
 * Implements `buildApprovedOpenBrowserResult` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildApprovedOpenBrowserResult(
  actionId: string,
  url = "http://127.0.0.1:3000/"
): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "open_browser",
      description: "open the live preview in the browser",
      params: {
        url
      },
      estimatedCostUsd: 0.07
    },
    mode: "escalation_path",
    approved: true,
    output: `Browser opened: ${url}`,
    executionStatus: "success",
    executionMetadata: {
      browserSession: true,
      browserSessionStatus: "open",
      browserSessionUrl: url,
      processLifecycleStatus: "PROCESS_READY"
    },
    blockedBy: [],
    violations: [],
    votes: []
  };
}

/**
 * Implements `buildBlockedFolderInUseShellResult` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildBlockedFolderInUseShellResult(actionId: string): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "shell_command",
      description: "move matching folders",
      params: {
        command: "Move-Item"
      },
      estimatedCostUsd: 0.08
    },
    mode: "escalation_path",
    approved: false,
    output:
      "Move-Item : The process cannot access the file because it is being used by another process.",
    executionStatus: "failed",
    executionFailureCode: "ACTION_EXECUTION_FAILED",
    blockedBy: [],
    violations: [],
    votes: []
  };
}

/**
 * Implements `buildBlockedMissingDependencyShellResult` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildBlockedMissingDependencyShellResult(actionId: string): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "shell_command",
      description: "build the current app",
      params: {
        command: "npm run build",
        cwd: "C:\\Users\\benac\\OneDrive\\Desktop\\Calm Drone"
      },
      estimatedCostUsd: 0.08
    },
    mode: "escalation_path",
    approved: false,
    output:
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@vitejs/plugin-react' imported from C:\\Users\\benac\\OneDrive\\Desktop\\Calm Drone\\vite.config.js",
    executionStatus: "failed",
    executionFailureCode: "ACTION_EXECUTION_FAILED",
    executionMetadata: {
      recoveryFailureClass: "DEPENDENCY_MISSING",
      recoveryFailureProvenance: "executor_mechanical"
    },
    blockedBy: ["ACTION_EXECUTION_FAILED"],
    violations: [
      {
        code: "ACTION_EXECUTION_FAILED",
        message: "Build failed because a dependency is missing."
      }
    ],
    votes: []
  };
}

/**
 * Implements `buildApprovedInspectWorkspaceResourcesResult` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildApprovedInspectWorkspaceResourcesResult(
  actionId: string,
  metadata: Record<string, string | number | boolean | null>
): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "inspect_workspace_resources",
      description: "inspect workspace resources",
      params: {
        rootPath: "C:\\Users\\test\\Desktop\\drone-company"
      },
      estimatedCostUsd: 0.04
    },
    mode: "escalation_path",
    approved: true,
    output: "Inspection results for C:\\Users\\test\\Desktop\\drone-company.",
    executionStatus: "success",
    executionMetadata: metadata,
    blockedBy: [],
    violations: [],
    votes: []
  };
}

/**
 * Implements `buildApprovedInspectPathHoldersResult` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildApprovedInspectPathHoldersResult(
  actionId: string,
  metadata: Record<string, string | number | boolean | null>
): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "inspect_path_holders",
      description: "inspect path holders",
      params: {
        path: "C:\\Users\\test\\Desktop\\drone-company"
      },
      estimatedCostUsd: 0.04
    },
    mode: "escalation_path",
    approved: true,
    output: "Inspection results for C:\\Users\\test\\Desktop\\drone-company.",
    executionStatus: "success",
    executionMetadata: metadata,
    blockedBy: [],
    violations: [],
    votes: []
  };
}

class StubLoopModelClient implements ModelClient {
  readonly backend = "mock" as const;
  private nextStepCallCount = 0;

  /**
   * Initializes class StubLoopModelClient dependencies and runtime state.
   * Interacts with local collaborators through imported modules and typed inputs/outputs.
   */
  constructor(
    private readonly nextStepOutputs: AutonomousNextStepModelOutput[],
    private readonly proactiveGoalOutput: ProactiveGoalModelOutput = {
      proactiveGoal: "noop",
      reasoning: "noop"
    }
  ) {}

  /**
   * Implements `completeJson` behavior within class StubLoopModelClient.
   * Interacts with local collaborators through imported modules and typed inputs/outputs.
   */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName === "autonomous_next_step_v1") {
      const selected =
        this.nextStepOutputs[this.nextStepCallCount] ??
        this.nextStepOutputs[this.nextStepOutputs.length - 1];
      this.nextStepCallCount += 1;
      return selected as T;
    }

    if (request.schemaName === "proactive_goal_v1") {
      return this.proactiveGoalOutput as T;
    }

    throw new Error(`Unsupported schema in stub model: ${request.schemaName}`);
  }
}

test("AutonomousLoop exits after immediate goal completion in non-daemon mode", async () => {
  const orchestrator = new StubOrchestrator();
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: true,
      reasoning: "done immediately",
      nextUserInput: ""
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  await loop.run("Test goal");
  assert.equal(orchestrator.runCount, 1);
});

test("AutonomousLoop performs follow-up iteration before completion", async () => {
  const orchestrator = new StubOrchestrator();
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: false,
      reasoning: "need one more step",
      nextUserInput: "second step"
    },
    {
      isGoalMet: true,
      reasoning: "completed after second step",
      nextUserInput: ""
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  await loop.run("Test goal");
  assert.equal(orchestrator.runCount, 2);
});

test("AutonomousLoop stops daemon mode after configured rollover limit", async () => {
  const orchestrator = new StubOrchestrator();
  const modelClient = new StubLoopModelClient(
    [
      {
        isGoalMet: true,
        reasoning: "first goal complete",
        nextUserInput: ""
      },
      {
        isGoalMet: true,
        reasoning: "second goal complete",
        nextUserInput: ""
      }
    ],
    {
      proactiveGoal: "Second overarching goal",
      reasoning: "continue running"
    }
  );
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    {
      ...DEFAULT_BRAIN_CONFIG,
      limits: { ...DEFAULT_BRAIN_CONFIG.limits, maxAutonomousIterations: 2 },
      runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: true }
    }
  );

  await loop.run("First overarching goal", undefined, undefined, 1);
  assert.equal(orchestrator.runCount, 2);
});

test("AutonomousLoop does not mark execution-style goals complete without approved non-respond side effects", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [buildApprovedRespondResult("respond_1")],
    [buildApprovedRespondResult("respond_2")],
    [buildApprovedRespondResult("respond_3")]
  ]);
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: true,
      reasoning: "instructions already provided",
      nextUserInput: ""
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let goalMetCalled = false;
  let abortedReason = "";
  await loop.run("Create a React app on my Desktop and execute now.", {
    onGoalMet: async () => {
      goalMetCalled = true;
    },
    onGoalAborted: async (reason) => {
      abortedReason = reason;
    }
  });

  assert.equal(goalMetCalled, false);
  assert.equal(orchestrator.runCount, 3);
  assert.match(abortedReason, /\[reasonCode=AUTONOMOUS_EXECUTION_STYLE_STALLED_NO_SIDE_EFFECT\]/i);
});

test("AutonomousLoop allows execution-style completion after side-effect evidence in earlier iteration", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [buildApprovedWriteFileResult("write_1")],
    [buildApprovedRespondResult("respond_summary")]
  ]);
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: false,
      reasoning: "verify and summarize",
      nextUserInput: "Summarize what was built and verify expected files."
    },
    {
      isGoalMet: true,
      reasoning: "side-effect evidence already exists in this mission",
      nextUserInput: ""
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let goalMetReasoning = "";
  await loop.run("Create a React app on my Desktop and execute now.", {
    onGoalMet: async (reasoning) => {
      goalMetReasoning = reasoning;
    }
  });

  assert.equal(orchestrator.runCount, 2);
  assert.match(goalMetReasoning, /side-effect evidence already exists/i);
});

test("AutonomousLoop does not count approved read_file as execution-style completion evidence", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [buildApprovedReadFileResult("read_1")],
    [buildApprovedReadFileResult("read_2")],
    [buildApprovedReadFileResult("read_3")]
  ]);
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: true,
      reasoning: "read-only validation complete",
      nextUserInput: ""
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let goalMetCalled = false;
  let abortedReason = "";
  await loop.run("Build a frontend on my Desktop and execute now.", {
    onGoalMet: async () => {
      goalMetCalled = true;
    },
    onGoalAborted: async (reason) => {
      abortedReason = reason;
    }
  });

  assert.equal(goalMetCalled, false);
  assert.equal(orchestrator.runCount, 3);
  assert.match(abortedReason, /\[reasonCode=AUTONOMOUS_EXECUTION_STYLE_STALLED_NO_SIDE_EFFECT\]/i);
});

test("AutonomousLoop does not count simulated shell success as execution-style completion evidence", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [buildApprovedSimulatedShellResult("shell_sim_1")],
    [buildApprovedSimulatedShellResult("shell_sim_2")],
    [buildApprovedSimulatedShellResult("shell_sim_3")]
  ]);
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: true,
      reasoning: "shell scaffolding complete",
      nextUserInput: ""
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let goalMetCalled = false;
  let abortedReason = "";
  await loop.run("Build a frontend on my Desktop and execute now.", {
    onGoalMet: async () => {
      goalMetCalled = true;
    },
    onGoalAborted: async (reason) => {
      abortedReason = reason;
    }
  });

  assert.equal(goalMetCalled, false);
  assert.equal(orchestrator.runCount, 3);
  assert.match(abortedReason, /\[reasonCode=AUTONOMOUS_EXECUTION_STYLE_STALLED_NO_SIDE_EFFECT\]/i);
});

test("AutonomousLoop classifies frontend build prompts as execution-style and gates respond-only completion", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [buildApprovedRespondResult("respond_frontend_1")],
    [buildApprovedRespondResult("respond_frontend_2")],
    [buildApprovedRespondResult("respond_frontend_3")]
  ]);
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: true,
      reasoning: "instructions already provided",
      nextUserInput: ""
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let goalMetCalled = false;
  let abortedReason = "";
  await loop.run("Build a frontend on my Desktop and execute now.", {
    onGoalMet: async () => {
      goalMetCalled = true;
    },
    onGoalAborted: async (reason) => {
      abortedReason = reason;
    }
  });

  assert.equal(goalMetCalled, false);
  assert.equal(orchestrator.runCount, 3);
  assert.match(abortedReason, /\[reasonCode=AUTONOMOUS_EXECUTION_STYLE_STALLED_NO_SIDE_EFFECT\]/i);
});

test("AutonomousLoop uses configurable no-progress stall threshold from runtime config", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [buildApprovedRespondResult("respond_cfg_1")],
    [buildApprovedRespondResult("respond_cfg_2")],
    [buildApprovedRespondResult("respond_cfg_3")],
    [buildApprovedRespondResult("respond_cfg_4")]
  ]);
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: false,
      reasoning: "keep executing",
      nextUserInput: "continue"
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    {
      ...DEFAULT_BRAIN_CONFIG,
      limits: {
        ...DEFAULT_BRAIN_CONFIG.limits,
        maxAutonomousIterations: 4,
        maxAutonomousConsecutiveNoProgressIterations: 5
      },
      runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false }
    }
  );

  let abortedReason = "";
  await loop.run("Build a frontend on my Desktop and execute now.", {
    onGoalAborted: async (reason) => {
      abortedReason = reason;
    }
  });

  assert.equal(orchestrator.runCount, 4);
  assert.match(abortedReason, /\[reasonCode=AUTONOMOUS_MAX_ITERATIONS_REACHED\]/i);
});

test("AutonomousLoop emits deterministic aborted reason when task execution throws", async () => {
  const orchestrator = new ThrowingOrchestrator();
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: false,
      reasoning: "continue",
      nextUserInput: "next"
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let goalMetCalled = false;
  let abortedReason = "";
  await loop.run("Create a React app on my Desktop and execute now.", {
    onGoalMet: async () => {
      goalMetCalled = true;
    },
    onGoalAborted: async (reason) => {
      abortedReason = reason;
    }
  });

  assert.equal(goalMetCalled, false);
  assert.equal(orchestrator.runCount, 1);
  assert.match(abortedReason, /\[reasonCode=AUTONOMOUS_TASK_EXECUTION_FAILED\]/i);
  assert.match(abortedReason, /timed out/i);
});

test("AutonomousLoop logs planner live-run failures in plain language", async () => {
  const orchestrator = {
    runCount: 0,
    async runTask(
      _task: TaskRequest,
      _options?: { signal?: AbortSignal }
    ): Promise<TaskRunResult> {
      orchestrator.runCount += 1;
      throw new Error(
        "Planner model returned no live-verification actions for execution-style live-run request."
      );
    }
  };
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: false,
      reasoning: "continue",
      nextUserInput: "next"
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  const originalConsoleLog = console.log;
  const loggedLines: string[] = [];
  console.log = (...args: unknown[]) => {
    loggedLines.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    await loop.run("Create a tiny local site, run it locally, and verify the homepage UI. Execute now.");
  } finally {
    console.log = originalConsoleLog;
  }

  const abortLine = loggedLines.find((line) => line.includes("[Autonomous Loop Aborted]")) ?? "";
  assert.equal(orchestrator.runCount, 1);
  assert.match(abortLine, /planner never produced a valid live-run verification plan/i);
  assert.match(
    abortLine,
    /next step: retry with an explicit request to start the app, prove readiness with probe_http, and then verify the page with verify_browser/i
  );
  assert.doesNotMatch(
    abortLine,
    /Planner model returned no live-verification actions for execution-style live-run request/i
  );
});

test("AutonomousLoop reports user cancellation when task execution aborts mid-iteration", async () => {
  const orchestrator = new AbortAwareOrchestrator();
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: false,
      reasoning: "continue",
      nextUserInput: "next"
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );
  const abortController = new AbortController();
  let abortedReason = "";

  const runPromise = loop.run(
    "Create a React app on my Desktop and execute now.",
    {
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    },
    abortController.signal
  );

  await orchestrator.started;
  abortController.abort();
  await runPromise;

  assert.equal(orchestrator.runCount, 1);
  assert.equal(abortedReason, "Cancelled by user.");
});

test("AutonomousLoop aborts cleanly when the next safe step requires a human reply", async () => {
  const orchestrator = new ScriptedOrchestrator([[buildApprovedRespondResult("respond_wait_gate")]]);
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: false,
      reasoning: "The remaining folders are still locked, so I need your confirmation before I continue.",
      nextUserInput:
        "Continue waiting for the user to reply with exactly \"ready\". Do not perform any file operations until then."
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let abortedReason = "";
  await loop.run(
    "Every folder with the name beginning in drone should go in drone-folder on my desktop.",
    {
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(orchestrator.runCount, 1);
  assert.match(abortedReason, /requires your reply or confirmation/i);
  assert.match(abortedReason, /remaining folders are still locked/i);
});

test("AutonomousLoop does not mark explicit-path missions complete when side effects touch a different path", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [buildApprovedShellResult("shell_1", `npx create-react-app ${WINDOWS_TEST_WRONG_APP_DIR}`)],
    [buildApprovedShellResult("shell_2", `npx create-react-app ${WINDOWS_TEST_WRONG_APP_DIR}`)],
    [buildApprovedShellResult("shell_3", `npx create-react-app ${WINDOWS_TEST_WRONG_APP_DIR}`)]
  ]);
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: true,
      reasoning: "work completed",
      nextUserInput: ""
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let goalMetCalled = false;
  let abortedReason = "";
  await loop.run(
    `Create a React app at ${WINDOWS_TEST_ROBINHOOD_MOCK_DIR} and execute now.`,
    {
      onGoalMet: async () => {
        goalMetCalled = true;
      },
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(goalMetCalled, false);
  assert.equal(orchestrator.runCount, 4);
  assert.match(abortedReason, /\[reasonCode=AUTONOMOUS_EXECUTION_STYLE_STALLED_NO_SIDE_EFFECT\]/i);
  assert.match(abortedReason, /TARGET_PATH_TOUCH/i);
});

test("AutonomousLoop requires artifact mutation evidence for customization-heavy execution goals", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [buildApprovedShellResult("shell_scaffold_1", `npx create-react-app ${WINDOWS_TEST_ROBINHOOD_MOCK_DIR}`)],
    [buildApprovedShellResult("shell_scaffold_2", `npx create-react-app ${WINDOWS_TEST_ROBINHOOD_MOCK_DIR}`)],
    [buildApprovedShellResult("shell_scaffold_3", `npx create-react-app ${WINDOWS_TEST_ROBINHOOD_MOCK_DIR}`)]
  ]);
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: true,
      reasoning: "scaffold exists",
      nextUserInput: ""
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let goalMetCalled = false;
  let abortedReason = "";
  await loop.run(
    `Create a React app at ${WINDOWS_TEST_ROBINHOOD_MOCK_DIR} with a modern dark theme, Robinhood-style UI, and stock components. Execute now.`,
    {
      onGoalMet: async () => {
        goalMetCalled = true;
      },
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(goalMetCalled, false);
  assert.equal(orchestrator.runCount, 4);
  assert.match(abortedReason, /\[reasonCode=AUTONOMOUS_EXECUTION_STYLE_STALLED_NO_SIDE_EFFECT\]/i);
  assert.match(abortedReason, /ARTIFACT_MUTATION/i);
});

test("AutonomousLoop allows customization-heavy execution completion after real mutation evidence", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [buildApprovedShellResult("shell_scaffold_1", `npx create-react-app ${WINDOWS_TEST_ROBINHOOD_MOCK_DIR}`)],
    [buildApprovedWriteFileResult("write_1")]
  ]);
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: false,
      reasoning: "continue",
      nextUserInput: "apply requested customizations"
    },
    {
      isGoalMet: true,
      reasoning: "customization files written",
      nextUserInput: ""
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let goalMetReasoning = "";
  await loop.run(
    "Create a React app on my Desktop with modern dark Robinhood-style UI components and execute now.",
    {
      onGoalMet: async (reasoning) => {
        goalMetReasoning = reasoning;
      }
    }
  );

  assert.equal(orchestrator.runCount, 2);
  assert.match(goalMetReasoning, /customization files written/i);
});

test("AutonomousLoop requires readiness proof for live verification execution goals", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [buildApprovedWriteFileResult("write_live_1")],
    [buildApprovedRespondResult("respond_live_1")],
    [buildApprovedRespondResult("respond_live_2")]
  ]);
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: true,
      reasoning: "the requested files were created",
      nextUserInput: ""
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    {
      ...DEFAULT_BRAIN_CONFIG,
      limits: {
        ...DEFAULT_BRAIN_CONFIG.limits,
        maxAutonomousConsecutiveNoProgressIterations: 2
      },
      runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false }
    }
  );

  let goalMetCalled = false;
  let abortedReason = "";
  await loop.run(
    "Create a React app, run it locally, and verify the homepage UI. Execute now.",
    {
      onGoalMet: async () => {
        goalMetCalled = true;
      },
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(goalMetCalled, false);
  assert.equal(orchestrator.runCount, 3);
  assert.match(abortedReason, /\[reasonCode=AUTONOMOUS_EXECUTION_STYLE_STALLED_NO_SIDE_EFFECT\]/i);
  assert.match(abortedReason, /READINESS_PROOF/i);
  assert.match(abortedReason, /BROWSER_PROOF/i);
});

test("AutonomousLoop does not allow explicit UI-verification completion after readiness proof alone", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [buildApprovedWriteFileResult("write_live_ready_1")],
    [buildApprovedProbePortReadyResult("probe_ready_1")],
    [buildApprovedRespondResult("respond_need_browser_proof")]
  ]);
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: false,
      reasoning: "start the local app and verify readiness",
      nextUserInput: "Start the app and prove localhost readiness."
    },
    {
      isGoalMet: true,
      reasoning: "localhost responded",
      nextUserInput: ""
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    {
      ...DEFAULT_BRAIN_CONFIG,
      limits: {
        ...DEFAULT_BRAIN_CONFIG.limits,
        maxAutonomousConsecutiveNoProgressIterations: 2
      },
      runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false }
    }
  );

  let goalMetCalled = false;
  let abortedReason = "";
  await loop.run(
    "Create a React app, run it locally, and verify the homepage UI. Execute now.",
    {
      onGoalMet: async () => {
        goalMetCalled = true;
      },
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(goalMetCalled, false);
  assert.equal(orchestrator.runCount, 3);
  assert.match(abortedReason, /READINESS_PROOF/i);
  assert.match(abortedReason, /BROWSER_PROOF/i);
});

test("AutonomousLoop does not count probe_port as readiness proof for explicit UI-verification goals", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [buildApprovedStartProcessResult("start_process_port_only_1", "proc_port_only_1")],
    [buildApprovedProbePortReadyResult("probe_port_ready_only_1")]
  ]);
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: false,
      reasoning: "server started",
      nextUserInput: "Prove localhost readiness."
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    {
      ...DEFAULT_BRAIN_CONFIG,
      limits: {
        ...DEFAULT_BRAIN_CONFIG.limits,
        maxAutonomousConsecutiveNoProgressIterations: 1
      },
      runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false }
    }
  );

  let abortedReason = "";
  await loop.run(
    "Create a React app, run it locally, and verify the homepage UI. Execute now.",
    {
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(orchestrator.runCount, 3);
  assert.match(abortedReason, /READINESS_PROOF/i);
  assert.match(abortedReason, /BROWSER_PROOF/i);
  assert.match(orchestrator.receivedInputs[2] ?? "", /^stop_process leaseId="proc_port_only_1"/i);
});

test("AutonomousLoop still allows probe_port readiness proof for readiness-only live goals", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [buildApprovedStartProcessResult("start_process_readiness_only_1", "proc_readiness_only_1")],
    [buildApprovedProbePortReadyResult("probe_port_readiness_only_1")]
  ]);
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: false,
      reasoning: "server started",
      nextUserInput: "Prove localhost readiness."
    },
    {
      isGoalMet: true,
      reasoning: "localhost readiness was proven",
      nextUserInput: ""
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let goalMetReasoning = "";
  await loop.run(
    "Run the local API and prove localhost readiness. Execute now.",
    {
      onGoalMet: async (reasoning) => {
        goalMetReasoning = reasoning;
      }
    }
  );

  assert.equal(orchestrator.runCount, 2);
  assert.match(goalMetReasoning, /localhost readiness was proven/i);
});

test("AutonomousLoop does not claim browser verification for finite readiness-only stop goals", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildApprovedStartProcessResult(
        "start_process_readiness_stop_only_1",
        "proc_readiness_stop_only_1",
        "python -m http.server 8127"
      ),
      buildApprovedProbeHttpReadyResult(
        "probe_http_readiness_stop_only_1",
        "http://localhost:8127"
      )
    ],
    [buildApprovedStopProcessResult("stop_process_readiness_stop_only_1", "proc_readiness_stop_only_1")]
  ]);
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: true,
      reasoning: "localhost readiness is proven",
      nextUserInput: ""
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let goalMetReasoning = "";
  await loop.run(
    "Run the local API on localhost:8127, keep the flow finite, and then stop the process. Execute now.",
    {
      onGoalMet: async (reasoning) => {
        goalMetReasoning = reasoning;
      }
    }
  );

  assert.equal(orchestrator.runCount, 2);
  assert.doesNotMatch(goalMetReasoning, /browser verification passed/i);
  assert.match(goalMetReasoning, /managed process was stopped/i);
});

test("AutonomousLoop allows explicit UI-verification completion after successful browser proof", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [buildApprovedWriteFileResult("write_live_browser_1")],
    [buildApprovedProbePortReadyResult("probe_ready_browser_1")],
    [buildApprovedVerifyBrowserResult("verify_browser_1")]
  ]);
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: false,
      reasoning: "start the app and prove localhost readiness",
      nextUserInput: "Start the app and prove localhost readiness."
    },
    {
      isGoalMet: false,
      reasoning: "browser proof still missing",
      nextUserInput: "Verify the homepage UI in a browser session."
    },
    {
      isGoalMet: true,
      reasoning: "browser verification passed",
      nextUserInput: ""
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let goalMetReasoning = "";
  await loop.run(
    "Create a React app, run it locally, and verify the homepage UI. Execute now.",
    {
      onGoalMet: async (reasoning) => {
        goalMetReasoning = reasoning;
      }
    }
  );

  assert.equal(orchestrator.runCount, 3);
  assert.match(goalMetReasoning, /browser verification passed/i);
});

test("AutonomousLoop completes after readiness and browser-open proof for run-and-leave-open preview goals", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildApprovedWriteFileResult("write_run_and_leave_open_1"),
      buildApprovedStartProcessResult(
        "start_process_run_and_leave_open_1",
        "proc_run_and_leave_open_1",
        "npm run dev",
        {
          host: "127.0.0.1",
          port: 3000,
          url: "http://127.0.0.1:3000/"
        }
      ),
      buildApprovedProbeHttpReadyResult(
        "probe_http_run_and_leave_open_1",
        "http://127.0.0.1:3000/"
      ),
      buildApprovedOpenBrowserResult(
        "open_browser_run_and_leave_open_1",
        "http://127.0.0.1:3000/"
      )
    ]
  ]);
  const modelClient: ModelClient = {
    backend: "mock",
    async completeJson<T>(_request: StructuredCompletionRequest): Promise<T> {
      throw new Error("completeJson should not be called after deterministic live browser-open proof");
    }
  };
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let abortedReason = "";
  let goalMetReasoning = "";
  await loop.run(
    'I want you to create a nextjs landing page, then run it and leave it open in the browser so i can review it.',
    {
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      },
      onGoalMet: async (reasoning) => {
        goalMetReasoning = reasoning;
      }
    }
  );

  assert.equal(orchestrator.runCount, 1);
  assert.equal(abortedReason, "");
  assert.match(goalMetReasoning, /left available in the browser/i);
});

test("AutonomousLoop requires stop-process proof for finite live-run goals before completion", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildApprovedStartProcessResult(
        "start_process_stop_required_1",
        "proc_stop_required_1",
        "python -m http.server 8123"
      ),
      buildApprovedProbeHttpReadyResult(
        "probe_http_stop_required_1",
        "http://localhost:8123"
      )
    ],
    [buildApprovedVerifyBrowserResult("verify_browser_stop_required_1")],
    [buildApprovedStopProcessResult("stop_process_stop_required_1", "proc_stop_required_1")]
  ]);
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: false,
      reasoning: "localhost is ready, so browser proof comes next",
      nextUserInput: "Verify the homepage UI in a browser session."
    },
    {
      isGoalMet: true,
      reasoning: "browser verification passed",
      nextUserInput: ""
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let goalMetReasoning = "";
  await loop.run(
    "Create a tiny local site on localhost:8123, verify the homepage UI in a real browser, keep the flow finite, and then stop the process. Execute now.",
    {
      onGoalMet: async (reasoning) => {
        goalMetReasoning = reasoning;
      }
    }
  );

  assert.equal(orchestrator.runCount, 3);
  assert.match(orchestrator.receivedInputs[2] ?? "", /^stop_process leaseId="proc_stop_required_1"/i);
  assert.match(goalMetReasoning, /browser verification passed/i);
});

test("AutonomousLoop credits bounded cleanup stop-proof when the iteration cap is reached", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildApprovedStartProcessResult(
        "start_process_stop_cap_1",
        "proc_stop_cap_1",
        "python -m http.server 8128"
      ),
      buildApprovedProbeHttpReadyResult(
        "probe_http_stop_cap_1",
        "http://localhost:8128"
      )
    ],
    [buildApprovedVerifyBrowserResult("verify_browser_stop_cap_1")],
    [buildApprovedStopProcessResult("stop_process_stop_cap_1", "proc_stop_cap_1")]
  ]);
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: false,
      reasoning: "browser proof comes next",
      nextUserInput: "Verify the homepage UI in a browser session."
    },
    {
      isGoalMet: true,
      reasoning: "browser verification passed",
      nextUserInput: ""
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    {
      ...DEFAULT_BRAIN_CONFIG,
      limits: {
        ...DEFAULT_BRAIN_CONFIG.limits,
        maxAutonomousIterations: 2
      },
      runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false }
    }
  );

  let goalMetReasoning = "";
  let abortedReason = "";
  await loop.run(
    "Run the local site on localhost:8128, verify the homepage UI in a real browser, keep the flow finite, and then stop the process. Execute now.",
    {
      onGoalMet: async (reasoning) => {
        goalMetReasoning = reasoning;
      },
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(orchestrator.runCount, 3);
  assert.match(orchestrator.receivedInputs[2] ?? "", /^stop_process leaseId="proc_stop_cap_1"/i);
  assert.equal(abortedReason, "");
  assert.match(goalMetReasoning, /managed process was stopped/i);
});

test("AutonomousLoop deterministically emits stop_process when cleanup is the only missing requirement", async () => {
  const loop = new AutonomousLoop(
    new StubOrchestrator() as unknown as BrainOrchestrator,
    {
      backend: "mock",
      async completeJson(): Promise<never> {
        throw new Error("evaluateNextStep should not call the model when only stop proof is missing.");
      }
    },
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  const lastResult: TaskRunResult = {
    task: {
      id: "task_stop_only",
      agentId: "main-agent",
      goal: "Create a tiny local site on localhost:8123, verify the homepage UI in a real browser, keep the flow finite, and then stop the process. Execute now.",
      userInput: "verify_browser url=\"http://localhost:8123\"",
      createdAt: new Date().toISOString()
    },
    plan: {
      taskId: "task_stop_only",
      plannerNotes: "stub",
      actions: [buildApprovedVerifyBrowserResult("verify_browser_stop_only_1").action]
    },
    actionResults: [buildApprovedVerifyBrowserResult("verify_browser_stop_only_1")],
    summary: "Browser verification passed.",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  };

  const nextStep = await (loop as unknown as {
    evaluateNextStep(
      overarchingGoal: string,
      lastResult: TaskRunResult,
      missionEvidence: {
        realSideEffects: number;
        targetPathTouches: number;
        artifactMutations: number;
        readinessProofs: number;
        browserProofs: number;
        browserOpenProofs: number;
        processStopProofs: number;
      },
      trackedManagedProcessLeaseId: string | null,
      trackedLoopbackTarget: { url: string | null; host: string | null; port: number | null } | null
    ): Promise<AutonomousNextStepModelOutput>;
  }).evaluateNextStep(
    lastResult.task.goal,
    lastResult,
    {
      realSideEffects: 1,
      targetPathTouches: 1,
      artifactMutations: 1,
      readinessProofs: 1,
      browserProofs: 1,
      browserOpenProofs: 0,
      processStopProofs: 0
    },
    "proc_stop_needed_1",
    {
      url: "http://localhost:8123",
      host: "localhost",
      port: 8123
    }
  );

  assert.equal(nextStep.isGoalMet, false);
  assert.match(nextStep.reasoning, /remaining required step is to stop/i);
  assert.match(nextStep.nextUserInput, /^stop_process leaseId="proc_stop_needed_1"/i);
});

test("AutonomousLoop deterministically finishes finite live-run goals once all proof is complete", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildApprovedStartProcessResult(
        "start_process_stop_complete_1",
        "proc_stop_complete_1",
        "python -m http.server 8124"
      ),
      buildApprovedProbeHttpReadyResult(
        "probe_http_stop_complete_1",
        "http://localhost:8124"
      )
    ],
    [buildApprovedVerifyBrowserResult("verify_browser_stop_complete_1")],
    [buildApprovedStopProcessResult("stop_process_stop_complete_1", "proc_stop_complete_1")]
  ]);
  let nextStepCallCount = 0;
  const modelClient: ModelClient = {
    backend: "mock",
    async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
      if (request.schemaName !== "autonomous_next_step_v1") {
        throw new Error(`Unexpected schema ${request.schemaName}`);
      }
      nextStepCallCount += 1;
      if (nextStepCallCount > 1) {
        throw new Error("live-run completion should not ask the model again after proof is complete");
      }
      return {
        isGoalMet: false,
        reasoning: "browser verification comes next",
        nextUserInput: "Verify the homepage UI in a browser session."
      } as T;
    }
  };
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let goalMetReasoning = "";
  await loop.run(
    "Create a tiny local site on localhost:8124, verify the homepage UI in a real browser, keep the flow finite, and then stop the process. Execute now.",
    {
      onGoalMet: async (reasoning) => {
        goalMetReasoning = reasoning;
      }
    }
  );

  assert.equal(orchestrator.runCount, 3);
  assert.equal(nextStepCallCount, 1);
  assert.match(goalMetReasoning, /evidence contract is complete/i);
});

test("AutonomousLoop retries explicit browser-proof goals with a Playwright install step", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [buildBlockedVerifyBrowserRuntimeUnavailableResult("verify_browser_missing_runtime")],
    [buildApprovedRespondResult("respond_install_recovery")]
  ]);
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: false,
      reasoning: "keep going",
      nextUserInput: "Retry browser verification."
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    {
      ...DEFAULT_BRAIN_CONFIG,
      limits: {
        ...DEFAULT_BRAIN_CONFIG.limits,
        maxAutonomousIterations: 2
      },
      runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false }
    }
  );

  await loop.run("Create a tiny local site, run it locally, and verify the homepage UI. Execute now.");

  assert.equal(orchestrator.receivedInputs.length, 2);
  assert.match(orchestrator.receivedInputs[1], /npm install --no-save playwright/i);
  assert.match(orchestrator.receivedInputs[1], /npx playwright install chromium/i);
  assert.match(orchestrator.receivedInputs[1], /retry the localhost browser verification/i);
});

test("AutonomousLoop inspects workspace holders before retrying a locked organization request", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [buildBlockedFolderInUseShellResult("shell_lock_1")],
    [buildApprovedRespondResult("respond_after_inspect_recovery")]
  ]);
  let nextStepCalls = 0;
  const modelClient: ModelClient = {
    backend: "mock",
    async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
      if (request.schemaName === "autonomous_next_step_v1") {
        nextStepCalls += 1;
        return {
          isGoalMet: true,
          reasoning: "done after deterministic recovery prompt",
          nextUserInput: ""
        } as T;
      }
      if (request.schemaName === "proactive_goal_v1") {
        return {
          proactiveGoal: "noop",
          reasoning: "noop"
        } as T;
      }
      throw new Error(`Unexpected schema ${request.schemaName}`);
    }
  };
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  await loop.run('Every folder with the name beginning in drone should go in "drone-folder" on my desktop.');

  assert.equal(orchestrator.receivedInputs.length, 2);
  assert.match(
    orchestrator.receivedInputs[1] ?? "",
    /Inspect the relevant workspace resources or path holders first/i
  );
  assert.equal(nextStepCalls, 1);
});

test("AutonomousLoop stops only exact tracked holders after inspected workspace evidence", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildBlockedFolderInUseShellResult("shell_lock_2"),
      buildApprovedInspectWorkspaceResourcesResult("inspect_workspace_1", {
        runtimeOwnershipInspection: true,
        inspectionRecommendedNextAction: "stop_exact_tracked_holders",
        inspectionPreviewProcessLeaseIds: "proc_preview_1,proc_preview_2"
      })
    ],
    [buildApprovedRespondResult("respond_after_exact_holder_recovery")]
  ]);
  let nextStepCalls = 0;
  const modelClient: ModelClient = {
    backend: "mock",
    async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
      if (request.schemaName === "autonomous_next_step_v1") {
        nextStepCalls += 1;
        return {
          isGoalMet: true,
          reasoning: "done after exact holder stop",
          nextUserInput: ""
        } as T;
      }
      if (request.schemaName === "proactive_goal_v1") {
        return {
          proactiveGoal: "noop",
          reasoning: "noop"
        } as T;
      }
      throw new Error(`Unexpected schema ${request.schemaName}`);
    }
  };
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  await loop.run('Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.');

  assert.equal(orchestrator.receivedInputs.length, 2);
  assert.match(orchestrator.receivedInputs[1] ?? "", /leaseId="proc_preview_1"/i);
  assert.match(orchestrator.receivedInputs[1] ?? "", /leaseId="proc_preview_2"/i);
  assert.equal(nextStepCalls, 1);
});

test("AutonomousLoop retries the original move after an exact tracked holder shutdown-only step", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildBlockedFolderInUseShellResult("shell_lock_retry_1"),
      buildApprovedInspectWorkspaceResourcesResult("inspect_workspace_retry_1", {
        runtimeOwnershipInspection: true,
        inspectionRecommendedNextAction: "stop_exact_tracked_holders",
        inspectionPreviewProcessLeaseIds: "proc_preview_retry_1"
      })
    ],
    [buildApprovedStopProcessResult("stop_process_retry_1", "proc_preview_retry_1")],
    [buildApprovedShellResult("shell_move_retry_1", "Move-Item -LiteralPath drone-company -Destination drone-folder")]
  ]);
  let nextStepCalls = 0;
  const modelClient: ModelClient = {
    backend: "mock",
    async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
      if (request.schemaName === "autonomous_next_step_v1") {
        nextStepCalls += 1;
        return {
          isGoalMet: true,
          reasoning: "the remaining folders were moved after the holder shutdown",
          nextUserInput: ""
        } as T;
      }
      if (request.schemaName === "proactive_goal_v1") {
        return {
          proactiveGoal: "noop",
          reasoning: "noop"
        } as T;
      }
      throw new Error(`Unexpected schema ${request.schemaName}`);
    }
  };
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  await loop.run('Every folder with the name beginning in drone should go in "drone-folder" on my desktop.');

  assert.equal(orchestrator.receivedInputs.length, 3);
  assert.match(orchestrator.receivedInputs[1] ?? "", /leaseId="proc_preview_retry_1"/i);
  assert.match(
    orchestrator.receivedInputs[2] ?? "",
    /Retry this original folder-organization goal now/i
  );
  assert.equal(nextStepCalls, 1);
});

test("AutonomousLoop retries the original move once after a clean inspection-only recovery step", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildApprovedInspectPathHoldersResult("inspect_path_retry_1", {
        runtimeOwnershipInspection: true,
        inspectionRecommendedNextAction: "collect_more_evidence",
        inspectionOwnershipClassification: "unknown"
      })
    ],
    [buildApprovedShellResult("shell_move_after_inspection_1", "Move-Item -LiteralPath drone-company -Destination drone-folder")]
  ]);
  let nextStepCalls = 0;
  const modelClient: ModelClient = {
    backend: "mock",
    async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
      if (request.schemaName === "autonomous_next_step_v1") {
        nextStepCalls += 1;
        return {
          isGoalMet: true,
          reasoning: "the remaining folders moved after the inspection retry",
          nextUserInput: ""
        } as T;
      }
      if (request.schemaName === "proactive_goal_v1") {
        return {
          proactiveGoal: "noop",
          reasoning: "noop"
        } as T;
      }
      throw new Error(`Unexpected schema ${request.schemaName}`);
    }
  };
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  await loop.run(
    'Every folder with the name beginning in drone should go in "drone-folder" on my desktop.',
    undefined,
    undefined,
    undefined,
    "Continue workspace-recovery for the same goal. First run inspect_path_holders on the remaining blocked paths: 1) C:\\Users\\testuser\\Desktop\\drone-company-a and 2) C:\\Users\\testuser\\Desktop\\drone-company-b."
  );

  assert.equal(orchestrator.receivedInputs.length, 2);
  assert.match(orchestrator.receivedInputs[1] ?? "", /Retry this original folder-organization goal now/i);
  assert.equal(nextStepCalls, 1);
});

test("AutonomousLoop aborts cleanly when the move is still blocked after a post-inspection retry", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildApprovedInspectPathHoldersResult("inspect_path_retry_2", {
        runtimeOwnershipInspection: true,
        inspectionRecommendedNextAction: "collect_more_evidence",
        inspectionOwnershipClassification: "unknown"
      })
    ],
    [buildBlockedFolderInUseShellResult("shell_lock_after_inspection_retry_1")]
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    {
      backend: "mock",
      async completeJson(): Promise<never> {
        throw new Error("evaluateNextStep should not run after the post-inspection retry stays blocked.");
      }
    },
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let abortedReason = "";
  await loop.run(
    'Every folder with the name beginning in drone should go in "drone-folder" on my desktop.',
    {
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    },
    undefined,
    undefined,
    "Continue workspace-recovery for the same goal. First run inspect_path_holders on the remaining blocked paths: 1) C:\\Users\\testuser\\Desktop\\drone-company-a and 2) C:\\Users\\testuser\\Desktop\\drone-company-b."
  );

  assert.equal(orchestrator.receivedInputs.length, 2);
  assert.match(abortedReason, /retried the move after inspection/i);
  assert.match(abortedReason, /could not prove a safe exact holder/i);
});

test("AutonomousLoop emits retrying state updates for exact tracked workspace recovery", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildBlockedFolderInUseShellResult("shell_lock_state_1"),
      buildApprovedInspectWorkspaceResourcesResult("inspect_workspace_state_1", {
        runtimeOwnershipInspection: true,
        inspectionRecommendedNextAction: "stop_exact_tracked_holders",
        inspectionPreviewProcessLeaseIds: "proc_preview_state_1"
      })
    ],
    [buildApprovedRespondResult("respond_after_state_retry")]
  ]);
  const modelClient: ModelClient = {
    backend: "mock",
    async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
      if (request.schemaName === "autonomous_next_step_v1") {
        return {
          isGoalMet: true,
          reasoning: "done after exact holder stop",
          nextUserInput: ""
        } as T;
      }
      if (request.schemaName === "proactive_goal_v1") {
        return {
          proactiveGoal: "noop",
          reasoning: "noop"
        } as T;
      }
      throw new Error(`Unexpected schema ${request.schemaName}`);
    }
  };
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );
  const states: string[] = [];

  await loop.run(
    'Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.',
    {
      onStateChange: async (update) => {
        states.push(`${update.state}:${update.message}`);
      }
    }
  );

  assert.match(states[0] ?? "", /^starting:/i);
  assert.ok(states.some((entry) => /^working:/i.test(entry)));
  assert.ok(
    states.some(
      (entry) =>
        /^retrying:/i.test(entry) &&
        /exact tracked holders/i.test(entry)
    )
  );
  assert.ok(states.some((entry) => /^completed:/i.test(entry)));
});

test("AutonomousLoop aborts when only untracked holder candidates remain for a locked organization request", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildBlockedFolderInUseShellResult("shell_lock_3"),
      buildApprovedInspectWorkspaceResourcesResult("inspect_workspace_2", {
        runtimeOwnershipInspection: true,
        inspectionRecommendedNextAction: "clarify_before_untracked_shutdown",
        inspectionUntrackedCandidatePids: "8801,8802"
      })
    ]
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    {
      backend: "mock",
      async completeJson(): Promise<never> {
        throw new Error("evaluateNextStep should not call the model when clarification is required.");
      }
    },
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let abortedReason = "";
  await loop.run(
    'Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.',
    {
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(orchestrator.runCount, 1);
  assert.match(abortedReason, /confirmation/i);
  assert.match(abortedReason, /8801, 8802/i);
});

test("AutonomousLoop aborts cleanly when inspection finds a small likely non-preview holder set", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildBlockedFolderInUseShellResult("shell_lock_non_preview_likely_1"),
      buildApprovedInspectWorkspaceResourcesResult("inspect_workspace_non_preview_likely_1", {
        runtimeOwnershipInspection: true,
        inspectionOwnershipClassification: "orphaned_attributable",
        inspectionRecommendedNextAction: "clarify_before_likely_non_preview_shutdown",
        inspectionUntrackedCandidatePids: "8810,8811",
        inspectionUntrackedCandidateKinds: "editor_workspace,shell_workspace",
        inspectionUntrackedCandidateNames: "Code.exe|explorer.exe",
        inspectionUntrackedCandidateConfidences: "medium,medium",
        inspectionUntrackedCandidateReasons:
          "command_line_mentions_target_name|command_line_mentions_target_name"
      })
    ]
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    {
      backend: "mock",
      async completeJson(): Promise<never> {
        throw new Error("evaluateNextStep should not call the model when a likely non-preview holder confirmation is required.");
      }
    },
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let abortedReason = "";
  await loop.run(
    'Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.',
    {
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(orchestrator.runCount, 1);
  assert.match(abortedReason, /small set of likely local editor or shell holders/i);
  assert.match(abortedReason, /8810, 8811/i);
});

test("AutonomousLoop retries the move once when inspection finds only stale tracked workspace records", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildBlockedFolderInUseShellResult("shell_lock_4"),
      buildApprovedInspectWorkspaceResourcesResult("inspect_workspace_3", {
        runtimeOwnershipInspection: true,
        inspectionOwnershipClassification: "stale_tracked",
        inspectionRecommendedNextAction: "collect_more_evidence",
        inspectionStalePreviewProcessLeaseIds: "proc_preview_old_1",
        inspectionStaleBrowserSessionIds: "browser_session:old_preview"
      })
    ],
    [buildApprovedShellResult("shell_move_after_stale_inspection_1", "Move-Item -LiteralPath drone-company -Destination drone-folder")]
  ]);
  let nextStepCalls = 0;
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    {
      backend: "mock",
      async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
        if (request.schemaName === "autonomous_next_step_v1") {
          nextStepCalls += 1;
          return {
            isGoalMet: true,
            reasoning: "the move succeeded after the stale-only retry",
            nextUserInput: ""
          } as T;
        }
        if (request.schemaName === "proactive_goal_v1") {
          return {
            proactiveGoal: "noop",
            reasoning: "noop"
          } as T;
        }
        throw new Error(`Unexpected schema ${request.schemaName}`);
      }
    },
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  await loop.run(
    'Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.',
    undefined
  );

  assert.equal(orchestrator.receivedInputs.length, 2);
  assert.match(orchestrator.receivedInputs[1] ?? "", /Retry this original folder-organization goal now/i);
  assert.equal(nextStepCalls, 1);
});

test("AutonomousLoop aborts cleanly when inspection finds only orphaned assistant browser state", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildBlockedFolderInUseShellResult("shell_lock_5"),
      buildApprovedInspectWorkspaceResourcesResult("inspect_workspace_4", {
        runtimeOwnershipInspection: true,
        inspectionOwnershipClassification: "orphaned_attributable",
        inspectionRecommendedNextAction: "manual_orphaned_browser_cleanup",
        inspectionOrphanedBrowserSessionIds: "browser_session:old_browser_preview"
      })
    ]
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    {
      backend: "mock",
      async completeJson(): Promise<never> {
        throw new Error("evaluateNextStep should not call the model when orphaned browser cleanup must be handled manually.");
      }
    },
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let abortedReason = "";
  await loop.run(
    'Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.',
    {
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(orchestrator.runCount, 1);
  assert.match(abortedReason, /older assistant browser windows/i);
  assert.match(abortedReason, /no longer have direct runtime control/i);
});

test("AutonomousLoop aborts cleanly when inspection finds only non-preview local holders", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildBlockedFolderInUseShellResult("shell_lock_non_preview_1"),
      buildApprovedInspectWorkspaceResourcesResult("inspect_workspace_non_preview_1", {
        runtimeOwnershipInspection: true,
        inspectionOwnershipClassification: "orphaned_attributable",
        inspectionRecommendedNextAction: "manual_non_preview_holder_cleanup",
        inspectionUntrackedCandidatePids: "8810",
        inspectionUntrackedCandidateKinds: "editor_workspace",
        inspectionUntrackedCandidateNames: "Code.exe"
      })
    ]
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    {
      backend: "mock",
      async completeJson(): Promise<never> {
        throw new Error("evaluateNextStep should not call the model when only non-preview local holders remain.");
      }
    },
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let abortedReason = "";
  await loop.run(
    'Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.',
    {
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(orchestrator.runCount, 1);
  assert.match(abortedReason, /non-preview local holders/i);
  assert.match(abortedReason, /editor, shell, or sync processes/i);
});

test("AutonomousLoop aborts cleanly with a targeted confirmation need for one high-confidence non-preview holder", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildBlockedFolderInUseShellResult("shell_lock_non_preview_exact_1"),
      buildApprovedInspectWorkspaceResourcesResult("inspect_workspace_non_preview_exact_1", {
        runtimeOwnershipInspection: true,
        inspectionOwnershipClassification: "orphaned_attributable",
        inspectionRecommendedNextAction: "clarify_before_exact_non_preview_shutdown",
        inspectionUntrackedCandidatePids: "8840",
        inspectionUntrackedCandidateKinds: "editor_workspace",
        inspectionUntrackedCandidateNames: "Code.exe",
        inspectionUntrackedCandidateConfidences: "high",
        inspectionUntrackedCandidateReasons: "command_line_matches_target_path"
      })
    ]
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    {
      backend: "mock",
      async completeJson(): Promise<never> {
        throw new Error("evaluateNextStep should not call the model when a targeted exact-holder confirmation is required.");
      }
    },
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let abortedReason = "";
  await loop.run(
    'Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.',
    {
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(orchestrator.runCount, 1);
  assert.match(abortedReason, /one high-confidence local holder/i);
  assert.match(abortedReason, /Code \(pid 8840\)/i);
});

test("AutonomousLoop aborts cleanly with a targeted confirmation need for one high-confidence sync holder", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildBlockedFolderInUseShellResult("shell_lock_non_preview_sync_exact_1"),
      buildApprovedInspectWorkspaceResourcesResult("inspect_workspace_non_preview_sync_exact_1", {
        runtimeOwnershipInspection: true,
        inspectionOwnershipClassification: "orphaned_attributable",
        inspectionRecommendedNextAction: "clarify_before_exact_non_preview_shutdown",
        inspectionUntrackedCandidatePids: "8850",
        inspectionUntrackedCandidateKinds: "sync_client",
        inspectionUntrackedCandidateNames: "OneDrive.exe",
        inspectionUntrackedCandidateConfidences: "high",
        inspectionUntrackedCandidateReasons: "command_line_matches_target_path"
      })
    ]
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    {
      backend: "mock",
      async completeJson(): Promise<never> {
        throw new Error("evaluateNextStep should not call the model when a targeted exact sync-holder confirmation is required.");
      }
    },
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let abortedReason = "";
  await loop.run(
    'Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.',
    {
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(orchestrator.runCount, 1);
  assert.match(abortedReason, /one high-confidence local holder/i);
  assert.match(abortedReason, /OneDrive \(pid 8850\)/i);
});

test("AutonomousLoop aborts cleanly with a contextual confirmation need for a still-bounded four-holder local editor and shell set", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildBlockedFolderInUseShellResult("shell_lock_non_preview_likely_four_1"),
      buildApprovedInspectWorkspaceResourcesResult("inspect_workspace_non_preview_likely_four_1", {
        runtimeOwnershipInspection: true,
        inspectionOwnershipClassification: "orphaned_attributable",
        inspectionRecommendedNextAction: "clarify_before_likely_non_preview_shutdown",
        inspectionUntrackedCandidatePids: "8810,8811,8812,8813",
        inspectionUntrackedCandidateKinds:
          "editor_workspace,shell_workspace,shell_workspace,editor_workspace",
        inspectionUntrackedCandidateNames:
          "Code.exe|explorer.exe|powershell.exe|Code.exe",
        inspectionUntrackedCandidateConfidences: "medium,medium,medium,medium",
        inspectionUntrackedCandidateReasons:
          "command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name"
      })
    ]
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    {
      backend: "mock",
      async completeJson(): Promise<never> {
        throw new Error("evaluateNextStep should not call the model when a contextual non-preview clarification is required.");
      }
    },
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let abortedReason = "";
  await loop.run(
    'Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.',
    {
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(orchestrator.runCount, 1);
  assert.match(abortedReason, /small set of likely local editor or shell holders/i);
  assert.match(abortedReason, /8810, 8811, 8812, 8813/i);
});

test("AutonomousLoop aborts cleanly with a contextual confirmation need for a broader five-holder local editor and shell set", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildBlockedFolderInUseShellResult("shell_lock_non_preview_likely_five_1"),
      buildApprovedInspectWorkspaceResourcesResult("inspect_workspace_non_preview_likely_five_1", {
        runtimeOwnershipInspection: true,
        inspectionOwnershipClassification: "orphaned_attributable",
        inspectionRecommendedNextAction: "clarify_before_likely_non_preview_shutdown",
        inspectionUntrackedCandidatePids: "8820,8821,8822,8823,8824",
        inspectionUntrackedCandidateKinds:
          "editor_workspace,shell_workspace,shell_workspace,editor_workspace,shell_workspace",
        inspectionUntrackedCandidateNames:
          "Code.exe|explorer.exe|powershell.exe|Code.exe|explorer.exe",
        inspectionUntrackedCandidateConfidences: "medium,medium,medium,low,low",
        inspectionUntrackedCandidateReasons:
          "command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name"
      })
    ]
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    {
      backend: "mock",
      async completeJson(): Promise<never> {
        throw new Error("evaluateNextStep should not call the model when a broader contextual non-preview clarification is required.");
      }
    },
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let abortedReason = "";
  await loop.run(
    'Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.',
    {
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(orchestrator.runCount, 1);
  assert.match(abortedReason, /broader inspected local editor or shell holder set/i);
  assert.match(abortedReason, /8820, 8821, 8822, 8823, 8824/i);
});

test("AutonomousLoop aborts cleanly with a contextual confirmation need for a broader seven-holder local editor and shell set", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildBlockedFolderInUseShellResult("shell_lock_non_preview_likely_seven_1"),
      buildApprovedInspectWorkspaceResourcesResult("inspect_workspace_non_preview_likely_seven_1", {
        runtimeOwnershipInspection: true,
        inspectionOwnershipClassification: "orphaned_attributable",
        inspectionRecommendedNextAction: "clarify_before_likely_non_preview_shutdown",
        inspectionUntrackedCandidatePids: "8820,8821,8822,8823,8824,8825,8826",
        inspectionUntrackedCandidateKinds:
          "editor_workspace,shell_workspace,shell_workspace,editor_workspace,shell_workspace,shell_workspace,editor_workspace",
        inspectionUntrackedCandidateNames:
          "Code.exe|explorer.exe|powershell.exe|Code.exe|explorer.exe|powershell.exe|Code.exe",
        inspectionUntrackedCandidateConfidences: "medium,medium,medium,medium,low,low,low",
        inspectionUntrackedCandidateReasons:
          "command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name"
      })
    ]
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    {
      backend: "mock",
      async completeJson(): Promise<never> {
        throw new Error("evaluateNextStep should not call the model when a broader contextual non-preview clarification is required.");
      }
    },
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let abortedReason = "";
  await loop.run(
    'Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.',
    {
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(orchestrator.runCount, 1);
  assert.match(abortedReason, /broader inspected local editor or shell holder set/i);
  assert.match(abortedReason, /8820, 8821, 8822, 8823, 8824, 8825, 8826/i);
});

test("AutonomousLoop aborts cleanly with a contextual confirmation need for a bounded mixed editor shell and sync holder set", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildBlockedFolderInUseShellResult("shell_lock_non_preview_likely_mixed_1"),
      buildApprovedInspectWorkspaceResourcesResult("inspect_workspace_non_preview_likely_mixed_1", {
        runtimeOwnershipInspection: true,
        inspectionOwnershipClassification: "orphaned_attributable",
        inspectionRecommendedNextAction: "clarify_before_likely_non_preview_shutdown",
        inspectionUntrackedCandidatePids: "8830,8831,8832",
        inspectionUntrackedCandidateKinds:
          "editor_workspace,shell_workspace,sync_client",
        inspectionUntrackedCandidateNames:
          "Code.exe|explorer.exe|OneDrive.exe",
        inspectionUntrackedCandidateConfidences: "medium,medium,medium",
        inspectionUntrackedCandidateReasons:
          "command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name"
      })
    ]
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    {
      backend: "mock",
      async completeJson(): Promise<never> {
        throw new Error("evaluateNextStep should not call the model when a bounded mixed non-preview clarification is required.");
      }
    },
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let abortedReason = "";
  await loop.run(
    'Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.',
    {
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(orchestrator.runCount, 1);
  assert.match(abortedReason, /small inspected local holder set across editor, shell, or sync processes/i);
  assert.match(abortedReason, /8830, 8831, 8832/i);
});

test("AutonomousLoop aborts cleanly with a contextual confirmation need for a bounded mixed holder set with a nearby exact-path local process", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildBlockedFolderInUseShellResult("shell_lock_non_preview_likely_nearby_local_1"),
      buildApprovedInspectWorkspaceResourcesResult("inspect_workspace_non_preview_likely_nearby_local_1", {
        runtimeOwnershipInspection: true,
        inspectionOwnershipClassification: "orphaned_attributable",
        inspectionRecommendedNextAction: "clarify_before_likely_non_preview_shutdown",
        inspectionUntrackedCandidatePids: "8830,8831,8832",
        inspectionUntrackedCandidateKinds:
          "editor_workspace,shell_workspace,unknown_local_process",
        inspectionUntrackedCandidateNames:
          "Code.exe|explorer.exe|AcmeDesktopHelper.exe",
        inspectionUntrackedCandidateConfidences: "medium,medium,medium",
        inspectionUntrackedCandidateReasons:
          "command_line_mentions_target_name|command_line_mentions_target_name|command_line_matches_target_path"
      })
    ]
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    {
      backend: "mock",
      async completeJson(): Promise<never> {
        throw new Error("evaluateNextStep should not call the model when a bounded mixed nearby-process clarification is required.");
      }
    },
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let abortedReason = "";
  await loop.run(
    'Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.',
    {
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(orchestrator.runCount, 1);
  assert.match(
    abortedReason,
    /small inspected local holder set across editor, shell, or nearby local processes/i
  );
  assert.match(abortedReason, /8830, 8831, 8832/i);
});

test("AutonomousLoop aborts cleanly with a contextual confirmation need for a broader five-holder mixed set with one nearby exact-path local process", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildBlockedFolderInUseShellResult("shell_lock_non_preview_likely_broader_nearby_local_1"),
      buildApprovedInspectWorkspaceResourcesResult("inspect_workspace_non_preview_likely_broader_nearby_local_1", {
        runtimeOwnershipInspection: true,
        inspectionOwnershipClassification: "orphaned_attributable",
        inspectionRecommendedNextAction: "clarify_before_likely_non_preview_shutdown",
        inspectionUntrackedCandidatePids: "8840,8841,8842,8843,8844",
        inspectionUntrackedCandidateKinds:
          "editor_workspace,shell_workspace,shell_workspace,editor_workspace,unknown_local_process",
        inspectionUntrackedCandidateNames:
          "Code.exe|explorer.exe|powershell.exe|Code.exe|AcmeDesktopHelper.exe",
        inspectionUntrackedCandidateConfidences: "medium,medium,medium,low,medium",
        inspectionUntrackedCandidateReasons:
          "command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_matches_target_path"
      })
    ]
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    {
      backend: "mock",
      async completeJson(): Promise<never> {
        throw new Error("evaluateNextStep should not call the model when a broader nearby-process clarification is required.");
      }
    },
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let abortedReason = "";
  await loop.run(
    'Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.',
    {
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(orchestrator.runCount, 1);
  assert.match(
    abortedReason,
    /broader inspected local holder set across editor, shell, or nearby local processes/i
  );
  assert.match(abortedReason, /8840, 8841, 8842, 8843, 8844/i);
});

test("AutonomousLoop aborts cleanly with a contextual confirmation need for a broader six-holder mixed set including sync and one nearby exact-path local process", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildBlockedFolderInUseShellResult("shell_lock_non_preview_likely_broader_sync_nearby_local_1"),
      buildApprovedInspectWorkspaceResourcesResult("inspect_workspace_non_preview_likely_broader_sync_nearby_local_1", {
        runtimeOwnershipInspection: true,
        inspectionOwnershipClassification: "orphaned_attributable",
        inspectionRecommendedNextAction: "clarify_before_likely_non_preview_shutdown",
        inspectionUntrackedCandidatePids: "8850,8851,8852,8853,8854,8855",
        inspectionUntrackedCandidateKinds:
          "editor_workspace,shell_workspace,shell_workspace,editor_workspace,sync_client,unknown_local_process",
        inspectionUntrackedCandidateNames:
          "Code.exe|explorer.exe|powershell.exe|Code.exe|OneDrive.exe|AcmeDesktopHelper.exe",
        inspectionUntrackedCandidateConfidences: "medium,medium,medium,low,medium,medium",
        inspectionUntrackedCandidateReasons:
          "command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_matches_target_path"
      })
    ]
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    {
      backend: "mock",
      async completeJson(): Promise<never> {
        throw new Error("evaluateNextStep should not call the model when a broader sync-plus-nearby clarification is required.");
      }
    },
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let abortedReason = "";
  await loop.run(
    'Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.',
    {
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(orchestrator.runCount, 1);
  assert.match(
    abortedReason,
    /broader inspected local holder set across editor, shell, sync, or nearby local processes/i
  );
  assert.match(abortedReason, /8850, 8851, 8852, 8853, 8854, 8855/i);
});

test("AutonomousLoop aborts cleanly with a contextual confirmation need for a broader seven-holder mixed set including sync and one nearby exact-path local process", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildBlockedFolderInUseShellResult("shell_lock_non_preview_likely_broader_sync_nearby_local_2"),
      buildApprovedInspectWorkspaceResourcesResult("inspect_workspace_non_preview_likely_broader_sync_nearby_local_2", {
        runtimeOwnershipInspection: true,
        inspectionOwnershipClassification: "orphaned_attributable",
        inspectionRecommendedNextAction: "clarify_before_likely_non_preview_shutdown",
        inspectionUntrackedCandidatePids: "8860,8861,8862,8863,8864,8865,8866",
        inspectionUntrackedCandidateKinds:
          "editor_workspace,shell_workspace,shell_workspace,editor_workspace,sync_client,shell_workspace,unknown_local_process",
        inspectionUntrackedCandidateNames:
          "Code.exe|explorer.exe|powershell.exe|Code.exe|OneDrive.exe|cmd.exe|AcmeDesktopHelper.exe",
        inspectionUntrackedCandidateConfidences: "medium,medium,medium,low,medium,low,medium",
        inspectionUntrackedCandidateReasons:
          "command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_matches_target_path"
      })
    ]
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    {
      backend: "mock",
      async completeJson(): Promise<never> {
        throw new Error("evaluateNextStep should not call the model when a broader seven-holder sync-plus-nearby clarification is required.");
      }
    },
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let abortedReason = "";
  await loop.run(
    'Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.',
    {
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(orchestrator.runCount, 1);
  assert.match(
    abortedReason,
    /broader inspected local holder set across editor, shell, sync, or nearby local processes/i
  );
  assert.match(abortedReason, /8860, 8861, 8862, 8863, 8864, 8865, 8866/i);
});

test("AutonomousLoop aborts cleanly with a contextual confirmation need for a broader eight-holder mixed set including sync and one nearby exact-path local process", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildBlockedFolderInUseShellResult("shell_lock_non_preview_likely_broader_sync_nearby_local_3"),
      buildApprovedInspectWorkspaceResourcesResult("inspect_workspace_non_preview_likely_broader_sync_nearby_local_3", {
        runtimeOwnershipInspection: true,
        inspectionOwnershipClassification: "orphaned_attributable",
        inspectionRecommendedNextAction: "clarify_before_likely_non_preview_shutdown",
        inspectionUntrackedCandidatePids: "8870,8871,8872,8873,8874,8875,8876,8877",
        inspectionUntrackedCandidateKinds:
          "editor_workspace,shell_workspace,shell_workspace,editor_workspace,sync_client,shell_workspace,editor_workspace,unknown_local_process",
        inspectionUntrackedCandidateNames:
          "Code.exe|explorer.exe|powershell.exe|Code.exe|OneDrive.exe|cmd.exe|Code.exe|AcmeDesktopHelper.exe",
        inspectionUntrackedCandidateConfidences: "medium,medium,medium,low,medium,low,medium,medium",
        inspectionUntrackedCandidateReasons:
          "command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_matches_target_path"
      })
    ]
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    {
      backend: "mock",
      async completeJson(): Promise<never> {
        throw new Error("evaluateNextStep should not call the model when a broader eight-holder sync-plus-nearby clarification is required.");
      }
    },
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let abortedReason = "";
  await loop.run(
    'Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.',
    {
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(orchestrator.runCount, 1);
  assert.match(
    abortedReason,
    /broader inspected local holder set across editor, shell, sync, or nearby local processes/i
  );
  assert.match(abortedReason, /8870, 8871, 8872, 8873, 8874, 8875, 8876, 8877/i);
});

test("AutonomousLoop aborts cleanly with a targeted confirmation need for multiple high-confidence non-preview holders", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildBlockedFolderInUseShellResult("shell_lock_non_preview_exact_multi_1"),
      buildApprovedInspectWorkspaceResourcesResult("inspect_workspace_non_preview_exact_multi_1", {
        runtimeOwnershipInspection: true,
        inspectionOwnershipClassification: "orphaned_attributable",
        inspectionRecommendedNextAction: "clarify_before_exact_non_preview_shutdown",
        inspectionUntrackedCandidatePids: "8840,8841,8842",
        inspectionUntrackedCandidateKinds: "editor_workspace,shell_workspace,shell_workspace",
        inspectionUntrackedCandidateNames: "Code.exe|explorer.exe|powershell.exe",
        inspectionUntrackedCandidateConfidences: "high,high,low",
        inspectionUntrackedCandidateReasons:
          "command_line_matches_target_path|command_line_matches_target_path|command_line_mentions_target_name"
      })
    ]
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    {
      backend: "mock",
      async completeJson(): Promise<never> {
        throw new Error("evaluateNextStep should not call the model when targeted exact-holder confirmation is required.");
      }
    },
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let abortedReason = "";
  await loop.run(
    'Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.',
    {
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(orchestrator.runCount, 1);
  assert.match(abortedReason, /2 high-confidence local holders/i);
  assert.match(abortedReason, /Code \(pid 8840\)/i);
  assert.match(abortedReason, /explorer \(pid 8841\)/i);
});

test("AutonomousLoop aborts cleanly with contextual manual cleanup wording for a broader nine-holder local family", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildBlockedFolderInUseShellResult("shell_lock_non_preview_contextual_1"),
      buildApprovedInspectWorkspaceResourcesResult("inspect_workspace_non_preview_contextual_1", {
        runtimeOwnershipInspection: true,
        inspectionOwnershipClassification: "orphaned_attributable",
        inspectionRecommendedNextAction: "manual_non_preview_holder_cleanup",
        inspectionUntrackedCandidatePids: "8880,8881,8882,8883,8884,8885,8886,8887,8888",
        inspectionUntrackedCandidateKinds:
          "shell_workspace,shell_workspace,shell_workspace,shell_workspace,shell_workspace,shell_workspace,shell_workspace,shell_workspace,unknown_local_process",
        inspectionUntrackedCandidateNames:
          "explorer.exe|powershell.exe|explorer.exe|powershell.exe|explorer.exe|powershell.exe|explorer.exe|powershell.exe|AcmeDesktopHelper.exe",
        inspectionUntrackedCandidateConfidences:
          "medium,medium,low,medium,low,medium,low,medium,medium",
        inspectionUntrackedCandidateReasons:
          "command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_matches_target_path"
      })
    ]
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    {
      backend: "mock",
      async completeJson(): Promise<never> {
        throw new Error("evaluateNextStep should not call the model when broader contextual manual cleanup is required.");
      }
    },
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let abortedReason = "";
  await loop.run(
    'Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.',
    {
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(orchestrator.runCount, 1);
  assert.match(
    abortedReason,
    /9 likely local non-preview holders across editor, shell, or nearby local processes/i
  );
  assert.match(abortedReason, /outside the confirmation lane/i);
  assert.match(abortedReason, /8880, 8881, 8882, 8883, 8884, 8885, 8886, 8887, 8888/i);
});

test("AutonomousLoop aborts cleanly with contextual manual cleanup wording for a grouped thirteen-holder local family", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildBlockedFolderInUseShellResult("shell_lock_non_preview_contextual_grouped_1"),
      buildApprovedInspectWorkspaceResourcesResult(
        "inspect_workspace_non_preview_contextual_grouped_1",
        {
          runtimeOwnershipInspection: true,
          inspectionOwnershipClassification: "orphaned_attributable",
          inspectionRecommendedNextAction: "manual_non_preview_holder_cleanup",
          inspectionUntrackedCandidatePids:
            "8890,8891,8892,8893,8894,8895,8896,8897,8898,8899,8900,8901,8902",
          inspectionUntrackedCandidateKinds:
            "editor_workspace,shell_workspace,shell_workspace,editor_workspace,shell_workspace,shell_workspace,editor_workspace,shell_workspace,shell_workspace,editor_workspace,shell_workspace,shell_workspace,unknown_local_process",
          inspectionUntrackedCandidateNames:
            "Code.exe|explorer.exe|powershell.exe|Code.exe|explorer.exe|powershell.exe|Code.exe|explorer.exe|powershell.exe|Code.exe|explorer.exe|powershell.exe|AcmeDesktopHelper.exe",
          inspectionUntrackedCandidateConfidences:
            "medium,medium,medium,medium,medium,medium,low,low,medium,low,low,medium,medium",
          inspectionUntrackedCandidateReasons:
            "command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_matches_target_path"
        }
      )
    ]
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    {
      backend: "mock",
      async completeJson(): Promise<never> {
        throw new Error(
          "evaluateNextStep should not call the model when grouped contextual manual cleanup is required."
        );
      }
    },
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let abortedReason = "";
  await loop.run(
    'Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.',
    {
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(orchestrator.runCount, 1);
  assert.match(
    abortedReason,
    /13 likely local non-preview holders across editor, shell, or nearby local processes/i
  );
  assert.match(abortedReason, /outside the confirmation lane/i);
  assert.match(
    abortedReason,
    /8890, 8891, 8892, 8893, 8894, 8895, 8896, 8897, 8898, 8899, 8900, 8901, 8902/i
  );
});

test("AutonomousLoop aborts cleanly with contextual manual cleanup wording for a grouped fifteen-holder local family with two nearby local processes", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildBlockedFolderInUseShellResult("shell_lock_non_preview_contextual_grouped_2"),
      buildApprovedInspectWorkspaceResourcesResult(
        "inspect_workspace_non_preview_contextual_grouped_2",
        {
          runtimeOwnershipInspection: true,
          inspectionOwnershipClassification: "orphaned_attributable",
          inspectionRecommendedNextAction: "manual_non_preview_holder_cleanup",
          inspectionUntrackedCandidatePids:
            "8910,8911,8912,8913,8914,8915,8916,8917,8918,8919,8920,8921,8922,8923,8924",
          inspectionUntrackedCandidateKinds:
            "editor_workspace,shell_workspace,shell_workspace,editor_workspace,shell_workspace,shell_workspace,editor_workspace,shell_workspace,shell_workspace,editor_workspace,shell_workspace,shell_workspace,editor_workspace,unknown_local_process,unknown_local_process",
          inspectionUntrackedCandidateNames:
            "Code.exe|explorer.exe|powershell.exe|Code.exe|explorer.exe|powershell.exe|Code.exe|explorer.exe|powershell.exe|Code.exe|explorer.exe|powershell.exe|Code.exe|AcmeDesktopHelper.exe|WatchBridgeService.exe",
          inspectionUntrackedCandidateConfidences:
            "medium,medium,medium,medium,medium,medium,low,low,medium,low,low,medium,medium,medium,medium",
          inspectionUntrackedCandidateReasons:
            "command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_matches_target_path|command_line_matches_target_path"
        }
      )
    ]
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    {
      backend: "mock",
      async completeJson(): Promise<never> {
        throw new Error(
          "evaluateNextStep should not call the model when grouped contextual manual cleanup with two nearby local processes is required."
        );
      }
    },
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let abortedReason = "";
  await loop.run(
    'Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.',
    {
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(orchestrator.runCount, 1);
  assert.match(
    abortedReason,
    /15 likely local non-preview holders across editor, shell, or nearby local processes/i
  );
  assert.match(abortedReason, /outside the confirmation lane/i);
  assert.match(
    abortedReason,
    /8910, 8911, 8912, 8913, 8914, 8915, 8916, 8917, 8918, 8919, 8920, 8921, 8922, 8923, 8924/i
  );
});

test("AutonomousLoop aborts cleanly with contextual manual cleanup wording for a grouped eighteen-holder mixed local family with two nearby local processes", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildBlockedFolderInUseShellResult("shell_lock_non_preview_contextual_grouped_3"),
      buildApprovedInspectWorkspaceResourcesResult(
        "inspect_workspace_non_preview_contextual_grouped_3",
        {
          runtimeOwnershipInspection: true,
          inspectionOwnershipClassification: "orphaned_attributable",
          inspectionRecommendedNextAction: "manual_non_preview_holder_cleanup",
          inspectionUntrackedCandidatePids:
            "8930,8931,8932,8933,8934,8935,8936,8937,8938,8939,8940,8941,8942,8943,8944,8945,8946,8947",
          inspectionUntrackedCandidateKinds:
            "editor_workspace,shell_workspace,shell_workspace,editor_workspace,shell_workspace,shell_workspace,editor_workspace,shell_workspace,shell_workspace,editor_workspace,shell_workspace,shell_workspace,editor_workspace,unknown_local_process,unknown_local_process,sync_client,sync_client,sync_client",
          inspectionUntrackedCandidateNames:
            "Code.exe|explorer.exe|powershell.exe|Code.exe|explorer.exe|powershell.exe|Code.exe|explorer.exe|powershell.exe|Code.exe|explorer.exe|powershell.exe|Code.exe|AcmeDesktopHelper.exe|WatchBridgeService.exe|OneDrive.exe|OneDrive.exe|OneDrive.exe",
          inspectionUntrackedCandidateConfidences:
            "medium,medium,medium,medium,medium,medium,low,low,medium,low,low,medium,medium,medium,medium,medium,medium,medium",
          inspectionUntrackedCandidateReasons:
            "command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_matches_target_path|command_line_matches_target_path|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name"
        }
      )
    ]
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    {
      backend: "mock",
      async completeJson(): Promise<never> {
        throw new Error(
          "evaluateNextStep should not call the model when grouped contextual manual cleanup with sync and two nearby local processes is required."
        );
      }
    },
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let abortedReason = "";
  await loop.run(
    'Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.',
    {
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(orchestrator.runCount, 1);
  assert.match(
    abortedReason,
    /18 likely local non-preview holders across editor, shell, sync, or nearby local processes/i
  );
  assert.match(abortedReason, /outside the confirmation lane/i);
  assert.match(
    abortedReason,
    /8930, 8931, 8932, 8933, 8934, 8935, 8936, 8937, 8938, 8939, 8940, 8941, 8942, 8943, 8944, 8945, 8946, 8947/i
  );
  assert.match(abortedReason, /Close or narrow that local holder set first, then ask me to retry/i);
});

test("AutonomousLoop aborts cleanly with contextual manual cleanup wording for a repeated-family twenty-four-holder mixed local family", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildBlockedFolderInUseShellResult("shell_lock_non_preview_contextual_grouped_4"),
      buildApprovedInspectWorkspaceResourcesResult(
        "inspect_workspace_non_preview_contextual_grouped_4",
        {
          runtimeOwnershipInspection: true,
          inspectionOwnershipClassification: "orphaned_attributable",
          inspectionRecommendedNextAction: "manual_non_preview_holder_cleanup",
          inspectionUntrackedCandidatePids:
            "8950,8951,8952,8953,8954,8955,8956,8957,8958,8959,8960,8961,8962,8963,8964,8965,8966,8967,8968,8969,8970,8971,8972,8973",
          inspectionUntrackedCandidateKinds:
            "editor_workspace,shell_workspace,shell_workspace,editor_workspace,shell_workspace,shell_workspace,editor_workspace,shell_workspace,shell_workspace,editor_workspace,shell_workspace,shell_workspace,editor_workspace,unknown_local_process,unknown_local_process,sync_client,sync_client,sync_client,editor_workspace,shell_workspace,shell_workspace,editor_workspace,shell_workspace,shell_workspace",
          inspectionUntrackedCandidateNames:
            "Code.exe|explorer.exe|powershell.exe|Code.exe|explorer.exe|powershell.exe|Code.exe|explorer.exe|powershell.exe|Code.exe|explorer.exe|powershell.exe|Code.exe|AcmeDesktopHelper.exe|WatchBridgeService.exe|OneDrive.exe|OneDrive.exe|OneDrive.exe|Code.exe|explorer.exe|powershell.exe|Code.exe|explorer.exe|powershell.exe",
          inspectionUntrackedCandidateConfidences:
            "medium,medium,medium,medium,medium,medium,low,low,medium,low,low,medium,medium,medium,medium,medium,medium,medium,medium,medium,medium,low,low,medium",
          inspectionUntrackedCandidateReasons:
            "command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_matches_target_path|command_line_matches_target_path|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name"
        }
      )
    ]
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    {
      backend: "mock",
      async completeJson(): Promise<never> {
        throw new Error(
          "evaluateNextStep should not call the model when repeated-family contextual manual cleanup is required."
        );
      }
    },
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let abortedReason = "";
  await loop.run(
    'Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.',
    {
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(orchestrator.runCount, 1);
  assert.match(
    abortedReason,
    /24 likely local non-preview holders across editor, shell, sync, or nearby local processes/i
  );
  assert.match(abortedReason, /outside the confirmation lane/i);
  assert.match(
    abortedReason,
    /8950, 8951, 8952, 8953, 8954, 8955, 8956, 8957, 8958, 8959, 8960, 8961, 8962, 8963, 8964, 8965, 8966, 8967, 8968, 8969, 8970, 8971, 8972, 8973/i
  );
});

test("AutonomousLoop stops early when live verification proof is blocked by the environment", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [buildApprovedWriteFileResult("write_live_site_1")],
    [buildBlockedProbeHttpGovernanceResult("probe_http_blocked_1")]
  ]);
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: false,
      reasoning: "start the local app and verify readiness",
      nextUserInput: "Start the local app and then prove localhost readiness."
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let abortedReason = "";
  await loop.run(
    "Create a tiny local site, run it locally, and verify the homepage UI. Execute now.",
    {
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(orchestrator.runCount, 2);
  assert.match(abortedReason, /AUTONOMOUS_EXECUTION_STYLE_LIVE_VERIFICATION_BLOCKED/i);
  assert.match(abortedReason, /could not truthfully confirm the app or page/i);
});

test("AutonomousLoop stops early when live verification is blocked by ethics and security governors", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [buildBlockedStartProcessEthicsSecurityResult("start_process_blocked_live_1")]
  ]);
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: false,
      reasoning: "try starting the local app",
      nextUserInput: "Start the local app and then prove localhost readiness."
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let abortedReason = "";
  await loop.run(
    "Create a tiny local site, run it locally, and verify the homepage UI. Execute now.",
    {
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(orchestrator.runCount, 1);
  assert.match(abortedReason, /AUTONOMOUS_EXECUTION_STYLE_LIVE_VERIFICATION_BLOCKED/i);
  assert.match(abortedReason, /could not truthfully confirm the app or page/i);
});

test("AutonomousLoop emits verifying state updates when execution proof is still missing", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildApprovedStartProcessResult("start_process_verify_state_1", "proc_verify_state_1"),
      buildApprovedProbeHttpReadyResult(
        "probe_http_verify_state_1",
        "http://127.0.0.1:3000/"
      )
    ],
    [buildApprovedVerifyBrowserResult("verify_browser_verify_state_1")]
  ]);
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: true,
      reasoning: "the app is up",
      nextUserInput: ""
    },
    {
      isGoalMet: true,
      reasoning: "browser verification passed",
      nextUserInput: ""
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );
  const states: string[] = [];

  await loop.run(
    "Create a tiny local site, run it locally, and verify the homepage UI. Execute now.",
    {
      onStateChange: async (update) => {
        states.push(`${update.state}:${update.message}`);
      }
    }
  );

  assert.ok(
    states.some(
      (entry) =>
        /^verifying:/i.test(entry) &&
        /browser result/i.test(entry)
    )
  );
});

test("AutonomousLoop aborts immediately when an inner task exhausts its retry budget", async () => {
  let modelCalls = 0;
  const orchestrator = {
    async runTask(task: TaskRequest): Promise<TaskRunResult> {
      return {
        task,
        plan: {
          taskId: task.id,
          plannerNotes: "stub",
          actions: [
            buildApprovedWriteFileResult("write_retry_budget_stop_1").action,
            {
              id: "respond_retry_budget_stop_1",
              type: "respond",
              description: "report retry budget exhaustion",
              params: {
                message: "Mission stop."
              },
              estimatedCostUsd: 0.01
            }
          ]
        },
        actionResults: [
          buildApprovedWriteFileResult("write_retry_budget_stop_1"),
          {
            action: {
              id: "respond_retry_budget_stop_1",
              type: "respond",
              description: "report retry budget exhaustion",
              params: {
                message: "Mission stop."
              },
              estimatedCostUsd: 0.01
            },
            mode: "fast_path",
            approved: false,
            output: "Mission retry budget exhausted.",
            executionStatus: "blocked",
            executionFailureCode: "MISSION_STOP_LIMIT_REACHED",
            blockedBy: ["MISSION_STOP_LIMIT_REACHED"],
            violations: [
              {
                code: "MISSION_STOP_LIMIT_REACHED",
                message: "Mission retry budget exhausted."
              }
            ],
            votes: []
          }
        ],
        summary:
          "Completed task with 1 approved action(s) and 2 blocked action(s) across 2 plan attempt(s). " +
          "Estimated approved action cost 0.08/10.00 USD. Model usage spend (provider-usage estimated) 0.000200/10.00 USD. " +
          "Recovery postmortem: MISSION_STOP_LIMIT_REACHED (Mission retry budget exhausted.).",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString()
      };
    }
  };
  const modelClient: ModelClient = {
    backend: "mock",
    async completeJson<T>(): Promise<T> {
      modelCalls += 1;
      throw new Error("evaluateNextStep should not run after mission stop limit is reached.");
    }
  };
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  let abortedReason = "";
  await loop.run(
    "Build the page and leave it open for me.",
    {
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(modelCalls, 0);
  assert.match(abortedReason, /retry budget/i);
});

test("AutonomousLoop retries a live-run goal on a suggested free port after start_process hits a loopback port conflict", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [buildBlockedStartProcessPortInUseResult("start_process_port_conflict_1", 8000, 8125)],
    [
      buildApprovedStartProcessResult(
        "start_process_port_conflict_2",
        "proc_port_conflict_1",
        "python -m http.server 8125"
      ),
      buildApprovedProbeHttpReadyResult(
        "probe_http_port_conflict_ready_1",
        "http://localhost:8125"
      )
    ],
    [buildApprovedVerifyBrowserResult("verify_browser_port_conflict_1")],
    [buildApprovedStopProcessResult("stop_process_port_conflict_1", "proc_port_conflict_1")]
  ]);
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: false,
      reasoning: "browser proof still missing",
      nextUserInput: "Verify the homepage UI in a browser session."
    },
    {
      isGoalMet: true,
      reasoning: "browser verification passed",
      nextUserInput: ""
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    {
      ...DEFAULT_BRAIN_CONFIG,
      limits: {
        ...DEFAULT_BRAIN_CONFIG.limits,
        maxAutonomousIterations: 4
      },
      runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false }
    }
  );

  let goalMetReasoning = "";
  await loop.run(
    "Create a tiny local test site, start it, wait until localhost is ready, verify the homepage UI in a real browser, keep the flow finite, and then stop the process. Execute now.",
    {
      onGoalMet: async (reasoning) => {
        goalMetReasoning = reasoning;
      }
    }
  );

  assert.equal(orchestrator.receivedInputs.length, 4);
  assert.match(orchestrator.receivedInputs[1] ?? "", /^start_process cmd="python -m http\.server 8125"/i);
  assert.match(orchestrator.receivedInputs[1] ?? "", /probe_http url="http:\/\/localhost:8125"/i);
  assert.match(orchestrator.receivedInputs[3] ?? "", /^stop_process leaseId="proc_port_conflict_1"/i);
  assert.match(goalMetReasoning, /browser verification passed/i);
});

test("AutonomousLoop schedules one bounded dependency repair iteration before falling back to the model", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [buildBlockedMissingDependencyShellResult("shell_missing_dependency_loop_1")],
    [buildApprovedWriteFileResult("write_dependency_repair_loop_1")]
  ]);
  let modelCalls = 0;
  const modelClient: ModelClient = {
    backend: "mock",
    async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
      if (request.schemaName === "autonomous_next_step_v1") {
        modelCalls += 1;
        return {
          isGoalMet: true,
          reasoning: "the bounded repair finished and the workspace mutation succeeded",
          nextUserInput: ""
        } as T;
      }
      if (request.schemaName === "proactive_goal_v1") {
        return {
          proactiveGoal: "noop",
          reasoning: "noop"
        } as T;
      }
      throw new Error(`Unsupported schema in test stub: ${request.schemaName}`);
    }
  };
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  await loop.run("Build the current app and fix any missing dependency if one deterministic repair is obvious.");

  assert.equal(orchestrator.receivedInputs.length, 2);
  assert.match(
    orchestrator.receivedInputs[1] ?? "",
    /\[STRUCTURED_RECOVERY_OPTION:repair_missing_dependency\]/i
  );
  assert.match(orchestrator.receivedInputs[1] ?? "", /@vitejs\/plugin-react/i);
  assert.equal(modelCalls, 1);
});

test("AutonomousLoop stops cleanly when the same bounded dependency repair fingerprint fails twice", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [buildBlockedMissingDependencyShellResult("shell_missing_dependency_stop_1")],
    [buildBlockedMissingDependencyShellResult("shell_missing_dependency_stop_2")]
  ]);
  let modelCalls = 0;
  const modelClient: ModelClient = {
    backend: "mock",
    async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
      if (request.schemaName === "autonomous_next_step_v1") {
        modelCalls += 1;
        throw new Error("The model should not be called while bounded repair handles this failure.");
      }
      if (request.schemaName === "proactive_goal_v1") {
        return {
          proactiveGoal: "noop",
          reasoning: "noop"
        } as T;
      }
      throw new Error(`Unsupported schema in test stub: ${request.schemaName}`);
    }
  };
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );
  let abortedReason = "";

  await loop.run(
    "Build the current app and repair exactly one obvious missing dependency if needed.",
    {
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(orchestrator.receivedInputs.length, 2);
  assert.match(
    orchestrator.receivedInputs[1] ?? "",
    /\[STRUCTURED_RECOVERY_OPTION:repair_missing_dependency\]/i
  );
  assert.equal(modelCalls, 0);
  assert.match(abortedReason, /deterministic missing-dependency repair budget is exhausted/i);
});

test("AutonomousLoop checks the managed-process lease after localhost readiness is not ready", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildApprovedStartProcessResult("start_process_live_1", "proc_live_check_1"),
      buildBlockedProbeHttpNotReadyResult("probe_http_not_ready_1")
    ],
    [buildApprovedProbePortReadyResult("probe_port_ready_after_check_1")]
  ]);
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: false,
      reasoning: "fallback model reasoning",
      nextUserInput: "fallback next step"
    },
    {
      isGoalMet: true,
      reasoning: "localhost is ready",
      nextUserInput: ""
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  await loop.run("Create a tiny local site, run it locally, and verify the homepage UI. Execute now.");

  assert.equal(orchestrator.receivedInputs.length >= 2, true);
  assert.match(orchestrator.receivedInputs[1] ?? "", /check_process/i);
  assert.match(orchestrator.receivedInputs[1] ?? "", /proc_live_check_1/i);
  assert.doesNotMatch(orchestrator.receivedInputs[1] ?? "", /verify_browser/i);
});

test("AutonomousLoop retries localhost readiness after check_process confirms the app is still running", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [buildApprovedCheckProcessStillRunningResult("check_process_live_1", "proc_live_check_2")],
    [buildApprovedProbePortReadyResult("probe_port_ready_live_2")]
  ]);
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: false,
      reasoning: "fallback model reasoning",
      nextUserInput: "fallback next step"
    },
    {
      isGoalMet: true,
      reasoning: "localhost is ready",
      nextUserInput: ""
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    { ...DEFAULT_BRAIN_CONFIG, runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false } }
  );

  await loop.run("Create a tiny local site, run it locally, and verify the homepage UI. Execute now.");

  assert.equal(orchestrator.receivedInputs.length >= 2, true);
  assert.match(orchestrator.receivedInputs[1] ?? "", /^probe_http/i);
  assert.doesNotMatch(orchestrator.receivedInputs[1] ?? "", /verify_browser/i);
});

test("AutonomousLoop rechecks the tracked managed-process lease after later HTTP not-ready failures", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildApprovedStartProcessResult("start_process_tracked_1", "proc_tracked_http_1"),
      buildBlockedProbeHttpNotReadyResult("probe_http_tracked_not_ready_1")
    ],
    [buildApprovedCheckProcessStillRunningResult("check_process_tracked_1", "proc_tracked_http_1")],
    [buildBlockedProbeHttpNotReadyResult("probe_http_tracked_not_ready_2")],
    [buildApprovedProbeHttpReadyResult("probe_http_tracked_ready_1")]
  ]);
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: false,
      reasoning: "fallback model reasoning",
      nextUserInput: "fallback next step"
    },
    {
      isGoalMet: false,
      reasoning: "fallback model reasoning",
      nextUserInput: "fallback next step"
    },
    {
      isGoalMet: true,
      reasoning: "localhost readiness was proven",
      nextUserInput: ""
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    {
      ...DEFAULT_BRAIN_CONFIG,
      limits: {
        ...DEFAULT_BRAIN_CONFIG.limits,
        maxAutonomousIterations: 4
      },
      runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false }
    }
  );

  await loop.run("Create a tiny local site, run it locally, and verify the homepage UI. Execute now.");

  assert.equal(orchestrator.receivedInputs.length, 5);
  assert.match(orchestrator.receivedInputs[1] ?? "", /check_process/i);
  assert.match(orchestrator.receivedInputs[1] ?? "", /proc_tracked_http_1/i);
  assert.match(orchestrator.receivedInputs[2] ?? "", /^probe_http/i);
  assert.match(orchestrator.receivedInputs[3] ?? "", /check_process/i);
  assert.match(orchestrator.receivedInputs[3] ?? "", /proc_tracked_http_1/i);
  assert.match(orchestrator.receivedInputs[4] ?? "", /^stop_process leaseId="proc_tracked_http_1"/i);
});

test("AutonomousLoop preserves the original loopback URL across readiness retries", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildApprovedStartProcessResult(
        "start_process_target_8000_1",
        "proc_target_8000_1",
        "python -m http.server 8000"
      ),
      buildBlockedProbeHttpNotReadyResult(
        "probe_http_target_8000_not_ready_1",
        "http://localhost:8000"
      )
    ],
    [buildApprovedCheckProcessStillRunningResult("check_process_target_8000_1", "proc_target_8000_1")],
    [buildBlockedProbeHttpNotReadyResult("probe_http_wrong_port_not_ready_1", "http://localhost:3000")],
    [buildApprovedCheckProcessStillRunningResult("check_process_target_8000_2", "proc_target_8000_1")],
    [buildApprovedProbeHttpReadyResult("probe_http_target_8000_ready_1", "http://localhost:8000")]
  ]);
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: true,
      reasoning: "localhost readiness was proven",
      nextUserInput: ""
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    {
      ...DEFAULT_BRAIN_CONFIG,
      limits: {
        ...DEFAULT_BRAIN_CONFIG.limits,
        maxAutonomousIterations: 5,
        maxAutonomousConsecutiveNoProgressIterations: 5
      },
      runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false }
    }
  );

  await loop.run("Create a tiny local site on localhost:8000, run it locally, and verify the homepage UI. Execute now.");

  assert.equal(orchestrator.receivedInputs.length, 6);
  assert.match(orchestrator.receivedInputs[1] ?? "", /check_process/i);
  assert.match(orchestrator.receivedInputs[1] ?? "", /http:\/\/localhost:8000/i);
  assert.match(orchestrator.receivedInputs[2] ?? "", /^probe_http url="http:\/\/localhost:8000"/i);
  assert.match(orchestrator.receivedInputs[3] ?? "", /check_process/i);
  assert.match(orchestrator.receivedInputs[3] ?? "", /http:\/\/localhost:8000/i);
  assert.doesNotMatch(orchestrator.receivedInputs[3] ?? "", /3000/i);
  assert.match(orchestrator.receivedInputs[4] ?? "", /^probe_http url="http:\/\/localhost:8000"/i);
  assert.match(orchestrator.receivedInputs[5] ?? "", /^stop_process leaseId="proc_target_8000_1"/i);
});

test("AutonomousLoop preserves typed loopback targets from generic workspace-native start commands", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildApprovedStartProcessResult(
        "start_process_vite_target_1",
        "proc_vite_target_1",
        "npm run dev",
        {
          host: "localhost",
          port: 4173,
          url: "http://localhost:4173"
        }
      ),
      buildBlockedProbeHttpNotReadyResult(
        "probe_http_vite_target_not_ready_1",
        "http://localhost:4173"
      )
    ],
    [buildApprovedCheckProcessStillRunningResult("check_process_vite_target_1", "proc_vite_target_1")],
    [buildBlockedProbeHttpNotReadyResult("probe_http_vite_wrong_port_not_ready_1", "http://localhost:5173")],
    [buildApprovedCheckProcessStillRunningResult("check_process_vite_target_2", "proc_vite_target_1")],
    [buildApprovedProbeHttpReadyResult("probe_http_vite_target_ready_1", "http://localhost:4173")]
  ]);
  const modelClient = new StubLoopModelClient([
    {
      isGoalMet: true,
      reasoning: "localhost readiness was proven",
      nextUserInput: ""
    }
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    modelClient,
    {
      ...DEFAULT_BRAIN_CONFIG,
      limits: {
        ...DEFAULT_BRAIN_CONFIG.limits,
        maxAutonomousIterations: 5,
        maxAutonomousConsecutiveNoProgressIterations: 5
      },
      runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false }
    }
  );

  await loop.run(
    "Build the Vite app, run npm run dev, wait until localhost is ready, verify the page, and keep the proof pinned to the actual preview port. Execute now."
  );

  assert.equal(orchestrator.receivedInputs.length, 6);
  assert.match(orchestrator.receivedInputs[1] ?? "", /check_process/i);
  assert.match(orchestrator.receivedInputs[1] ?? "", /http:\/\/localhost:4173/i);
  assert.match(orchestrator.receivedInputs[2] ?? "", /^probe_http url="http:\/\/localhost:4173"/i);
  assert.match(orchestrator.receivedInputs[3] ?? "", /check_process/i);
  assert.match(orchestrator.receivedInputs[3] ?? "", /http:\/\/localhost:4173/i);
  assert.doesNotMatch(orchestrator.receivedInputs[3] ?? "", /5173/i);
  assert.match(orchestrator.receivedInputs[4] ?? "", /^probe_http url="http:\/\/localhost:4173"/i);
  assert.match(orchestrator.receivedInputs[5] ?? "", /^stop_process leaseId="proc_vite_target_1"/i);
});

test("AutonomousLoop stops and cleans up a managed process that never becomes HTTP-ready", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [
      buildApprovedStartProcessResult(
        "start_process_never_ready_1",
        "proc_never_ready_1",
        "python -m http.server 8000"
      ),
      buildBlockedProbeHttpNotReadyResult(
        "probe_http_never_ready_1",
        "http://localhost:8000"
      )
    ],
    [buildApprovedCheckProcessStillRunningResult("check_process_never_ready_1", "proc_never_ready_1")],
    [buildBlockedProbeHttpNotReadyResult("probe_http_never_ready_2", "http://localhost:8000")],
    [buildApprovedCheckProcessStillRunningResult("check_process_never_ready_2", "proc_never_ready_1")],
    [buildBlockedProbeHttpNotReadyResult("probe_http_never_ready_3", "http://localhost:8000")],
    [buildApprovedStopProcessResult("stop_process_cleanup_never_ready_1", "proc_never_ready_1")]
  ]);
  const loop = new AutonomousLoop(
    orchestrator as unknown as BrainOrchestrator,
    new StubLoopModelClient([]),
    {
      ...DEFAULT_BRAIN_CONFIG,
      limits: {
        ...DEFAULT_BRAIN_CONFIG.limits,
        maxAutonomousIterations: 6,
        maxAutonomousConsecutiveNoProgressIterations: 10
      },
      runtime: { ...DEFAULT_BRAIN_CONFIG.runtime, isDaemonMode: false }
    }
  );
  let abortedReason = "";

  await loop.run(
    "Create a tiny local site on localhost:8000, run it locally, and verify the homepage UI. Execute now.",
    {
      onGoalAborted: async (reason) => {
        abortedReason = reason;
      }
    }
  );

  assert.equal(orchestrator.receivedInputs.length, 6);
  assert.match(abortedReason, /AUTONOMOUS_EXECUTION_STYLE_PROCESS_NEVER_READY/i);
  assert.match(orchestrator.receivedInputs[5] ?? "", /^stop_process leaseId="proc_never_ready_1"/i);
});
