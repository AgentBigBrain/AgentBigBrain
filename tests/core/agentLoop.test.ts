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
  command = "python -m http.server 3000"
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
      processPid: 4242
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

test("AutonomousLoop does not mark explicit-path missions complete when side effects touch a different path", async () => {
  const orchestrator = new ScriptedOrchestrator([
    [buildApprovedShellResult("shell_1", "npx create-react-app C:\\Users\\benac\\OneDrive\\Desktop\\wrong-app")],
    [buildApprovedShellResult("shell_2", "npx create-react-app C:\\Users\\benac\\OneDrive\\Desktop\\wrong-app")],
    [buildApprovedShellResult("shell_3", "npx create-react-app C:\\Users\\benac\\OneDrive\\Desktop\\wrong-app")]
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
    "Create a React app at C:\\Users\\benac\\OneDrive\\Desktop\\robinhood-mock and execute now.",
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
    [buildApprovedShellResult("shell_scaffold_1", "npx create-react-app C:\\Users\\benac\\OneDrive\\Desktop\\robinhood-mock")],
    [buildApprovedShellResult("shell_scaffold_2", "npx create-react-app C:\\Users\\benac\\OneDrive\\Desktop\\robinhood-mock")],
    [buildApprovedShellResult("shell_scaffold_3", "npx create-react-app C:\\Users\\benac\\OneDrive\\Desktop\\robinhood-mock")]
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
    "Create a React app at C:\\Users\\benac\\OneDrive\\Desktop\\robinhood-mock with a modern dark theme, Robinhood-style UI, and stock components. Execute now.",
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
    [buildApprovedShellResult("shell_scaffold_1", "npx create-react-app C:\\Users\\benac\\OneDrive\\Desktop\\robinhood-mock")],
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
