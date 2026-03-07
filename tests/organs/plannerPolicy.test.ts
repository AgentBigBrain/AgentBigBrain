/**
 * @fileoverview Tests extracted planner-policy modules directly.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { TaskRequest } from "../../src/core/types";
import { ModelClient, StructuredCompletionRequest } from "../../src/models/types";
import {
  assertPlannerActionValidation,
  evaluatePlannerActionValidation,
  preparePlannerActions
} from "../../src/organs/plannerPolicy/explicitActionRepair";
import {
  PlannerPromptBuildInput,
  type PlannerExecutionEnvironmentContext
} from "../../src/organs/plannerPolicy/executionStyleContracts";
import {
  buildPlannerRepairSystemPrompt,
  buildPlannerSystemPrompt
} from "../../src/organs/plannerPolicy/promptAssembly";
import {
  buildNonExplicitRunSkillFallbackAction,
  enforceRunSkillIntentPolicy,
  ensureRespondMessages
} from "../../src/organs/plannerPolicy/responseSynthesisFallback";

class ResponseOnlyModelClient implements ModelClient {
  readonly backend = "mock" as const;

  constructor(private readonly message: string) {}

  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName !== "response_v1") {
      throw new Error(`Unexpected schema request: ${request.schemaName}`);
    }
    return {
      message: this.message
    } as T;
  }
}

function buildTask(userInput: string): TaskRequest {
  return {
    id: "task_planner_policy",
    agentId: "main-agent",
    goal: "Handle user request safely and efficiently.",
    userInput,
    createdAt: new Date().toISOString()
  };
}

function buildExecutionEnvironment(): PlannerExecutionEnvironmentContext {
  return {
    platform: "linux",
    shellKind: "bash",
    invocationMode: "inline_command",
    commandMaxChars: 2048
  };
}

function buildPromptInput(currentUserRequest: string): PlannerPromptBuildInput {
  const task = buildTask(currentUserRequest);
  return {
    task,
    plannerModel: "mock-planner",
    lessonsText: "",
    firstPrinciplesGuidance: "",
    learningGuidance: "",
    currentUserRequest,
    requiredActionType: null,
    playbookSelection: null,
    executionEnvironment: buildExecutionEnvironment()
  };
}

test("preparePlannerActions filters non-explicit run_skill-only output and flags the collapse", () => {
  const preparation = preparePlannerActions(
    {
      plannerNotes: "run skill only",
      actions: [
        {
          type: "run_skill",
          description: "run workflow skill",
          params: {
            name: "workflow_skill"
          }
        }
      ]
    },
    "Research deterministic sandboxing controls and provide distilled findings.",
    null
  );

  assert.deepEqual(preparation.actions, []);
  assert.equal(preparation.filteredRunSkillOnly, true);
});

test("evaluatePlannerActionValidation and assertPlannerActionValidation fail closed for missing browser proof", () => {
  const currentUserRequest =
    "Create a React app on my Desktop, run the app, and verify the homepage UI. Execute now.";
  const validation = evaluatePlannerActionValidation(currentUserRequest, null, [
    {
      id: "action_shell_build",
      type: "shell_command",
      description: "install and build the app",
      params: {
        command: "npm install && npm run build"
      },
      estimatedCostUsd: 0.12
    },
    {
      id: "action_start_live_run",
      type: "start_process",
      description: "start the local app",
      params: {
        command: "npm run dev"
      },
      estimatedCostUsd: 0.08
    },
    {
      id: "action_probe_http",
      type: "probe_http",
      description: "probe localhost readiness",
      params: {
        url: "http://localhost:3000"
      },
      estimatedCostUsd: 0.03
    }
  ]);

  assert.equal(validation.needsRepair, true);
  assert.equal(validation.buildPlanAssessment.issueCode, "BROWSER_VERIFICATION_ACTION_REQUIRED");
  assert.throws(
    () => assertPlannerActionValidation(validation, null),
    /no verify_browser action for explicit browser\/UI verification request/i
  );
});

test("buildPlannerSystemPrompt includes execution environment and live-verification guidance", () => {
  const prompt = buildPlannerSystemPrompt(
    buildPromptInput(
      "Create a React app on my Desktop, run the app, and verify the homepage UI. Execute now."
    )
  );

  assert.match(prompt, /Execution Environment:/i);
  assert.match(prompt, /shellKind:\s+bash/i);
  assert.match(prompt, /Live-run verification intent detected/i);
  assert.match(prompt, /use verify_browser with params\.url/i);
});

test("buildPlannerRepairSystemPrompt includes repair-specific action requirements", () => {
  const prompt = buildPlannerRepairSystemPrompt({
    ...buildPromptInput('verify_browser url=http://localhost:8000 expect_title="Smoke"'),
    requiredActionType: "verify_browser",
    previousOutput: {
      plannerNotes: "invalid output",
      actions: []
    },
    repairReason: "missing_required_action:verify_browser"
  });

  assert.match(prompt, /repairing a planner JSON output that had no valid actions/i);
  assert.match(prompt, /Repair must include at least one verify_browser action/i);
});

test("ensureRespondMessages backfills missing respond text and run-skill post-policy can fall back to respond", async () => {
  const modelClient = new ResponseOnlyModelClient("safe response-only plan");
  const task = buildTask("Research deterministic sandboxing controls and provide distilled findings.");
  const backfilledActions = await ensureRespondMessages(
    modelClient,
    [
      {
        id: "action_missing_message",
        type: "respond",
        description: "reply to the user",
        params: {},
        estimatedCostUsd: 0.01
      }
    ],
    task,
    "mock-synth"
  );

  assert.equal(backfilledActions[0].params.message, "safe response-only plan");

  const postPolicy = await enforceRunSkillIntentPolicy(
    modelClient,
    [
      {
        id: "action_run_skill_only",
        type: "run_skill",
        description: "run workflow skill",
        params: {
          name: "workflow_skill"
        },
        estimatedCostUsd: 0.05
      }
    ],
    task,
    "mock-synth",
    task.userInput
  );

  assert.equal(postPolicy.usedFallback, true);
  assert.equal(postPolicy.actions[0].type, "respond");
  assert.equal(postPolicy.actions[0].params.message, "safe response-only plan");

  const fallback = buildNonExplicitRunSkillFallbackAction("fallback message");
  assert.equal(fallback.type, "respond");
  assert.equal(fallback.params.message, "fallback message");
});
