/**
 * @fileoverview Tests canonical orchestrator learning helpers extracted into the orchestration subsystem.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { JudgmentSignalType } from "../../src/core/judgmentPatterns";
import {
  deriveJudgmentObjectiveScore,
  persistLearningSignals
} from "../../src/core/orchestration/orchestratorLearning";

function buildRunResult(approvedFlags: boolean[]) {
  return {
    task: {
      id: "task_orchestrator_learning_1",
      goal: "test",
      userInput: "test",
      createdAt: "2026-03-07T12:00:00.000Z"
    },
    plan: {
      taskId: "task_orchestrator_learning_1",
      plannerNotes: "stub",
      actions: approvedFlags.map((_, index) => ({
        id: `action_${index + 1}`,
        type: "respond" as const,
        description: "respond",
        params: { message: "ok" },
        estimatedCostUsd: 0.01
      }))
    },
    actionResults: approvedFlags.map((approved, index) => ({
      action: {
        id: `action_${index + 1}`,
        type: "respond" as const,
        description: "respond",
        params: { message: "ok" },
        estimatedCostUsd: 0.01
      },
      mode: "fast_path" as const,
      approved,
      output: approved ? "ok" : "blocked",
      blockedBy: approved ? [] : ["safety"],
      violations: [],
      votes: []
    })),
    summary: "summary",
    startedAt: "2026-03-07T12:00:00.000Z",
    completedAt: "2026-03-07T12:00:05.000Z"
  };
}

test("deriveJudgmentObjectiveScore returns balanced score from approved vs blocked actions", () => {
  assert.equal(deriveJudgmentObjectiveScore(buildRunResult([]) as never), 0);
  assert.equal(deriveJudgmentObjectiveScore(buildRunResult([true, false, true]) as never), 0.3333);
});

test("persistLearningSignals writes workflow and judgment outcomes", async () => {
  let workflowRecorded = 0;
  let judgmentRecorded = 0;
  let objectiveSignal = 0;

  await persistLearningSignals(
    {
      workflowLearningStore: {
        recordObservation: async () => {
          workflowRecorded += 1;
        }
      } as never,
      judgmentPatternStore: {
        recordPattern: async () => {
          judgmentRecorded += 1;
          return { id: "pattern_1" };
        },
        applyOutcomeSignal: async (
          _patternId: string,
          signalType: JudgmentSignalType,
          score: number
        ) => {
          if (signalType === "objective") {
            objectiveSignal = score;
          }
        }
      } as never
    },
    buildRunResult([true, false, true]) as never
  );

  assert.equal(workflowRecorded, 1);
  assert.equal(judgmentRecorded, 1);
  assert.equal(objectiveSignal, 0.3333);
});
