/**
 * @fileoverview Tests autonomous-loop control flow for non-daemon iterative execution.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_BRAIN_CONFIG } from "../../src/core/config";
import { AutonomousLoop } from "../../src/core/agentLoop";
import { BrainOrchestrator } from "../../src/core/orchestrator";
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
  async runTask(task: TaskRequest): Promise<TaskRunResult> {
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
  override async runTask(task: TaskRequest): Promise<TaskRunResult> {
    this.runCount += 1;
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
