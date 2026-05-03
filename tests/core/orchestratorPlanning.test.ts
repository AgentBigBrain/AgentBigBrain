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
  assert.equal((capturedContext as ConversationDomainContext | null)?.dominantLane, "workflow");
});

test("loadPlannerLearningContext returns empty hints for blank current request", async () => {
  const result = await loadPlannerLearningContext({}, "Current user request:\n   ");

  assert.deepEqual(result, {
    workflowHints: [],
    judgmentHints: [],
    workflowBridge: null,
    skillGuidance: []
  });
});

test("loadPlannerLearningContext passes the session lane into workflow hint retrieval", async () => {
  let capturedLane: string | null = null;
  const result = await loadPlannerLearningContext(
    {
      workflowLearningStore: {
        getRelevantPatterns: async (
          _query: string,
          _limit: number,
          sessionDomainLane: ConversationDomainContext["dominantLane"] | null
        ) => {
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
    workflowBridge: null,
    skillGuidance: []
  });
});

test("loadPlannerLearningContext includes bounded Markdown skill guidance", async () => {
  const result = await loadPlannerLearningContext(
    {
      listApplicableGuidance: async (query, limit) => {
        assert.match(query, /static site/i);
        assert.equal(limit, 3);
        return [
          {
            name: "static-site-generation",
            origin: "builtin",
            description: "Static site guidance.",
            tags: ["static", "site"],
            invocationHints: ["Ask me to use guidance skill static-site-generation."],
            selectionSource: "source_controlled_builtin_manifest",
            advisoryAuthority: "advisory_only",
            matchedTerms: ["static", "site"],
            guidance: "Prefer a single index.html when no framework is required."
          }
        ];
      }
    },
    "Current user request:\nBuild a static site."
  );

  assert.equal(result.skillGuidance.length, 1);
  assert.equal(result.skillGuidance[0]?.name, "static-site-generation");
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
      plan: async (
        _task: unknown,
        _plannerModel: unknown,
        _synthesizerModel: unknown,
        options: unknown
      ) => {
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
      },
      skillGuidance: []
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
  assert.equal(
    (capturedPlannerOptions as Record<string, unknown> | null)?.conversationDomainContext !== undefined,
    true
  );
  assert.equal(
    (capturedPlannerOptions as Record<string, unknown> | null)?.workflowBridge !== undefined,
    true
  );
  assert.equal(
    (capturedPlannerOptions as Record<string, unknown> | null)?.skillGuidance !== undefined,
    true
  );
});

test("planOrchestratorAttempt applies the generic cap to stale deterministic framework lifecycle notes", async () => {
  const plan = await planOrchestratorAttempt({
    appendTraceEvent: async () => {},
    maxActionsPerTask: 8,
    planner: {
      plan: async () => ({
        taskId: "task_orchestrator_planning_framework_fallback",
        plannerNotes:
          "Deterministic framework build lifecycle fallback " +
          "(deterministic_framework_build_fallback=shell_command)",
        actions: [
          {
            id: "action_1",
            type: "shell_command",
            description: "scaffold",
            params: { command: "scaffold" },
            estimatedCostUsd: 0.01
          },
          {
            id: "action_2",
            type: "write_file",
            description: "layout",
            params: { path: "layout.js", content: "" },
            estimatedCostUsd: 0.01
          },
          {
            id: "action_3",
            type: "write_file",
            description: "page",
            params: { path: "page.js", content: "" },
            estimatedCostUsd: 0.01
          },
          {
            id: "action_4",
            type: "write_file",
            description: "styles",
            params: { path: "globals.css", content: "" },
            estimatedCostUsd: 0.01
          },
          {
            id: "action_5",
            type: "shell_command",
            description: "install",
            params: { command: "npm install" },
            estimatedCostUsd: 0.01
          },
          {
            id: "action_6",
            type: "shell_command",
            description: "workspace proof",
            params: { command: "proof" },
            estimatedCostUsd: 0.01
          },
          {
            id: "action_7",
            type: "shell_command",
            description: "build",
            params: { command: "npm run build" },
            estimatedCostUsd: 0.01
          },
          {
            id: "action_8",
            type: "shell_command",
            description: "build proof",
            params: { command: "proof build" },
            estimatedCostUsd: 0.01
          },
          {
            id: "action_9",
            type: "start_process",
            description: "start",
            params: { command: "npm run dev" },
            estimatedCostUsd: 0.01
          },
          {
            id: "action_10",
            type: "probe_http",
            description: "probe",
            params: { url: "http://127.0.0.1:3000" },
            estimatedCostUsd: 0.01
          },
          {
            id: "action_11",
            type: "open_browser",
            description: "open",
            params: { url: "http://127.0.0.1:3000", rootPath: "C:\\Users\\testuser\\Desktop\\Detroit City" },
            estimatedCostUsd: 0.01
          }
        ]
      })
    } as never,
    plannerLearningContext: {
      workflowHints: [],
      judgmentHints: [],
      workflowBridge: null,
      skillGuidance: []
    },
    plannerModel: "planner-model",
    resolvePlaybookPlanningContext: async (): Promise<Stage685PlaybookPlanningContext> => ({
      selectedPlaybookId: null,
      selectedPlaybookName: null,
      fallbackToPlanner: true,
      reason: "fallback",
      requestedTags: [],
      requiredInputSchema: "none",
      registryValidated: true,
      scoreSummary: []
    }),
    synthesizerModel: "synth-model",
    task: {
      id: "task_orchestrator_planning_framework_fallback",
      goal: "build and leave open",
      userInput: "build and leave open",
      createdAt: "2026-03-07T12:00:00.000Z"
    },
    attemptNumber: 1,
    userInput: "build and leave open"
  });

  assert.equal(plan.actions.length, 8);
  assert.equal(plan.actions.some((action) => action.type === "start_process"), false);
  assert.equal(plan.actions.some((action) => action.type === "probe_http"), false);
  assert.equal(plan.actions.some((action) => action.type === "open_browser"), false);
});
