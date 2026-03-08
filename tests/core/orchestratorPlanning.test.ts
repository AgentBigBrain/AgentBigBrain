/**
 * @fileoverview Tests canonical orchestrator planning helpers extracted into the orchestration subsystem.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildProfileAwareInput,
  loadPlannerLearningContext,
  planOrchestratorAttempt
} from "../../src/core/orchestration/orchestratorPlanning";

test("buildProfileAwareInput delegates to the memory broker", async () => {
  const result = await buildProfileAwareInput(
    {
      memoryBroker: {
        buildPlannerInput: async () => ({
          userInput: "planner input",
          profileMemoryStatus: "attached"
        })
      } as never
    },
    {
      id: "task_orchestrator_planning_1",
      goal: "test",
      userInput: "user input",
      createdAt: "2026-03-07T12:00:00.000Z"
    }
  );

  assert.deepEqual(result, {
    userInput: "planner input",
    profileMemoryStatus: "attached"
  });
});

test("loadPlannerLearningContext returns empty hints for blank current request", async () => {
  const result = await loadPlannerLearningContext({}, "Current user request:\n   ");

  assert.deepEqual(result, {
    workflowHints: [],
    judgmentHints: []
  });
});

test("planOrchestratorAttempt caps actions and annotates planner notes", async () => {
  const traceEvents: Array<Record<string, unknown>> = [];
  const plan = await planOrchestratorAttempt({
    appendTraceEvent: async (event) => {
      traceEvents.push(event as Record<string, unknown>);
    },
    maxActionsPerTask: 1,
    planner: {
      plan: async () => ({
        taskId: "task_orchestrator_planning_2",
        plannerNotes: "base notes",
        actions: [
          {
            id: "action_1",
            type: "respond",
            description: "respond",
            params: { message: "hi" },
            estimatedCostUsd: 0.01
          },
          {
            id: "action_2",
            type: "respond",
            description: "respond again",
            params: { message: "hi again" },
            estimatedCostUsd: 0.01
          }
        ],
        learningHints: {
          workflowHintCount: 2,
          judgmentHintCount: 1,
          workflowHints: [],
          judgmentHints: []
        }
      })
    } as never,
    plannerLearningContext: {
      workflowHints: [],
      judgmentHints: []
    },
    plannerModel: "planner-model",
    resolvePlaybookPlanningContext: async () => ({
      selectedPlaybookId: "build_live_run",
      fallbackToPlanner: false,
      triggerMatches: []
    }),
    synthesizerModel: "synth-model",
    task: {
      id: "task_orchestrator_planning_2",
      goal: "test planning",
      userInput: "original request",
      createdAt: "2026-03-07T12:00:00.000Z"
    },
    attemptNumber: 2,
    userInput: "attempt request"
  });

  assert.equal(plan.actions.length, 1);
  assert.equal(
    plan.plannerNotes,
    "base notes [playbook=build_live_run] [replanAttempt=2]"
  );
  assert.equal(traceEvents[0]?.eventType, "planner_completed");
  assert.equal(traceEvents[0]?.details?.attemptNumber, 2);
});
