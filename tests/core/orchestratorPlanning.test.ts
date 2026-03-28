/**
 * @fileoverview Tests canonical orchestrator planning helpers extracted into the orchestration subsystem.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AppendRuntimeTraceEventInput } from "../../src/core/runtimeTraceLogger";
import type { Stage685PlaybookPlanningContext } from "../../src/core/stage6_85/playbookRuntime";
import type { ConversationDomainContext } from "../../src/core/types";
import {
  buildProfileAwareInput,
  loadPlannerLearningContext,
  planOrchestratorAttempt
} from "../../src/core/orchestration/orchestratorPlanning";

test("buildProfileAwareInput delegates to the memory broker", async () => {
  let capturedContext: ConversationDomainContext | null = null;
  const result = await buildProfileAwareInput(
    {
      memoryBroker: {
        buildPlannerInput: async (
          _task: {
            id: string;
            goal: string;
            userInput: string;
            createdAt: string;
          },
          options?: { sessionDomainContext?: ConversationDomainContext | null }
        ) => {
          capturedContext = options?.sessionDomainContext ?? null;
          return {
          userInput: "planner input",
          profileMemoryStatus: "attached"
          };
        }
      } as never
    },
    {
      id: "task_orchestrator_planning_1",
      goal: "test",
      userInput: "user input",
      createdAt: "2026-03-07T12:00:00.000Z"
    },
    {
      conversationDomainContext: {
        conversationId: "telegram:chat:user",
        dominantLane: "workflow",
        recentLaneHistory: [],
        recentRoutingSignals: [],
        continuitySignals: {
          activeWorkspace: true,
          returnHandoff: false,
          modeContinuity: true
        },
        activeSince: "2026-03-20T12:00:00.000Z",
        lastUpdatedAt: "2026-03-20T12:01:00.000Z"
      }
    }
  );

  assert.deepEqual(result, {
    userInput: "planner input",
    profileMemoryStatus: "attached"
  });
  assert.equal(capturedContext?.dominantLane, "workflow");
});

test("loadPlannerLearningContext returns empty hints for blank current request", async () => {
  const result = await loadPlannerLearningContext({}, "Current user request:\n   ");

  assert.deepEqual(result, {
    workflowHints: [],
    judgmentHints: [],
    workflowBridge: null
  });
});

test("loadPlannerLearningContext passes the session lane into workflow hint retrieval", async () => {
  let capturedLane: string | null = null;
  const result = await loadPlannerLearningContext(
    {
      workflowLearningStore: {
        getRelevantPatterns: async (_query, _limit, sessionDomainLane) => {
          capturedLane = sessionDomainLane;
          return [];
        }
      } as never
    },
    "Current user request:\nSummarize the status update.",
    {
      conversationDomainContext: {
        conversationId: "telegram:chat:user",
        dominantLane: "workflow",
        recentLaneHistory: [],
        recentRoutingSignals: [],
        continuitySignals: {
          activeWorkspace: true,
          returnHandoff: false,
          modeContinuity: true
        },
        activeSince: "2026-03-20T12:00:00.000Z",
        lastUpdatedAt: "2026-03-20T12:01:00.000Z"
      }
    }
  );

  assert.equal(capturedLane, "workflow");
  assert.deepEqual(result, {
    workflowHints: [],
    judgmentHints: [],
    workflowBridge: null
  });
});

test("planOrchestratorAttempt caps actions and annotates planner notes", async () => {
  const traceEvents: Array<Record<string, unknown>> = [];
  let capturedPlannerOptions: Record<string, unknown> | null = null;
  const plan = await planOrchestratorAttempt({
    appendTraceEvent: async (event) => {
      traceEvents.push(event as unknown as Record<string, unknown>);
    },
    maxActionsPerTask: 1,
    planner: {
      plan: async (_task, _plannerModel, _synthesizerModel, options) => {
        capturedPlannerOptions = (options ?? null) as unknown as Record<string, unknown> | null;
        return {
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
        };
      }
    } as never,
    plannerLearningContext: {
      workflowHints: [],
      judgmentHints: [],
      workflowBridge: {
        preferredSkill: null,
        preferredWorkflowKey: null,
        preferredReason: null,
        discouragedWorkflowKeys: [],
        skillSuggestions: []
      }
    },
    plannerModel: "planner-model",
    resolvePlaybookPlanningContext: async (): Promise<Stage685PlaybookPlanningContext> => ({
      selectedPlaybookId: "build_live_run",
      selectedPlaybookName: "Build Live Run",
      fallbackToPlanner: false,
      reason: "Matched build_live_run.",
      requestedTags: [],
      requiredInputSchema: "none",
      registryValidated: true,
      scoreSummary: []
    }),
    synthesizerModel: "synth-model",
    task: {
      id: "task_orchestrator_planning_2",
      goal: "test planning",
      userInput: "original request",
      createdAt: "2026-03-07T12:00:00.000Z"
    },
    attemptNumber: 2,
    userInput: "attempt request",
    conversationDomainContext: {
      conversationId: "telegram:chat:user",
      dominantLane: "workflow",
      recentLaneHistory: [],
      recentRoutingSignals: [],
      continuitySignals: {
        activeWorkspace: true,
        returnHandoff: false,
        modeContinuity: true
      },
      activeSince: "2026-03-20T12:00:00.000Z",
      lastUpdatedAt: "2026-03-20T12:01:00.000Z"
    }
  });

  assert.equal(plan.actions.length, 1);
  assert.equal(
    plan.plannerNotes,
    "base notes [playbook=build_live_run] [replanAttempt=2]"
  );
  assert.equal(traceEvents[0]?.eventType, "planner_completed");
  assert.equal((traceEvents[0]?.details as AppendRuntimeTraceEventInput["details"])?.attemptNumber, 2);
  assert.equal(capturedPlannerOptions?.conversationDomainContext !== undefined, true);
  assert.equal(capturedPlannerOptions?.workflowBridge !== undefined, true);
});
