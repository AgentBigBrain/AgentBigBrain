/**
 * @fileoverview Tests autonomous-loop control flow for non-daemon iterative execution.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_BRAIN_CONFIG } from "../../src/core/config";
import { AutonomousLoop } from "../../src/core/agentLoop";
import { BrainOrchestrator } from "../../src/core/orchestrator";
import { TaskRequest, TaskRunResult } from "../../src/core/types";
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
