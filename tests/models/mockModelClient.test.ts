/**
 * @fileoverview Tests deterministic mock model behavior for planner and governor schemas.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MockModelClient } from "../../src/models/mockModelClient";
import {
  AutonomousNextStepModelOutput,
  GovernorModelOutput,
  IntentInterpretationModelOutput,
  LanguageEpisodeExtractionModelOutput,
  PlannerModelOutput,
  ProactiveGoalModelOutput,
  ResponseSynthesisModelOutput
} from "../../src/models/types";
import {
  WINDOWS_TEST_IMPORTANT_FILE_PATH
} from "../support/windowsPathFixtures";

test("MockModelClient returns structured planner actions", async () => {
  const client = new MockModelClient();
  const output = await client.completeJson<PlannerModelOutput>({
    model: "mock-planner",
    schemaName: "planner_v1",
    systemPrompt: "planner",
    userPrompt: JSON.stringify({
      userInput: `Delete ${WINDOWS_TEST_IMPORTANT_FILE_PATH}`
    })
  });

  assert.ok(output.actions.length >= 1);
  assert.equal(output.actions[0].type, "delete_file");
});

test("MockModelClient can reject by governor policy signals", async () => {
  const client = new MockModelClient();
  const output = await client.completeJson<GovernorModelOutput>({
    model: "mock-governor",
    schemaName: "governor_v1",
    systemPrompt: "governor",
    userPrompt: JSON.stringify({
      governorId: "security",
      actionType: "delete_file",
      actionDescription: "Delete file",
      rationale: "Cleanup old files",
      path: WINDOWS_TEST_IMPORTANT_FILE_PATH
    })
  });

  assert.equal(output.approve, false);
});

test("MockModelClient can produce create_skill actions for planner schema", async () => {
  const client = new MockModelClient();
  const output = await client.completeJson<PlannerModelOutput>({
    model: "mock-planner",
    schemaName: "planner_v1",
    systemPrompt: "planner",
    userPrompt: JSON.stringify({
      userInput: "Create markdown skill parser_tool with instructions: Parse workflow notes."
    })
  });

  assert.ok(output.actions.some((action) => action.type === "create_skill"));
});

test("MockModelClient can produce run_skill actions for planner schema", async () => {
  const client = new MockModelClient();
  const output = await client.completeJson<PlannerModelOutput>({
    model: "mock-planner",
    schemaName: "planner_v1",
    systemPrompt: "planner",
    userPrompt: JSON.stringify({
      userInput: "Use skill parser_tool with input: hello"
    })
  });

  assert.ok(output.actions.some((action) => action.type === "run_skill"));
});

test("MockModelClient does not invent skill source when create-skill content is missing", async () => {
  const client = new MockModelClient();
  const output = await client.completeJson<PlannerModelOutput>({
    model: "mock-planner",
    schemaName: "planner_v1",
    systemPrompt: "planner",
    userPrompt: JSON.stringify({
      userInput: "Create skill parser_tool for this workflow"
    })
  });

  assert.equal(output.actions.length, 1);
  assert.equal(output.actions[0].type, "respond");
});

test("MockModelClient uses explicit executable skill source when provided", async () => {
  const client = new MockModelClient();
  const output = await client.completeJson<PlannerModelOutput>({
    model: "mock-planner",
    schemaName: "planner_v1",
    systemPrompt: "planner",
    userPrompt: JSON.stringify({
      userInput:
        "Create skill parser_tool with code: export function parserTool(input: string): string { return input.trim(); }"
    })
  });

  const createSkillAction = output.actions.find((action) => action.type === "create_skill");
  assert.ok(createSkillAction);
  const createSkillParams = createSkillAction.params;
  assert.ok(createSkillParams);
  assert.equal(createSkillParams.kind, "executable_module");
  assert.match(String(createSkillParams.code), /parserTool/);
});

test("MockModelClient does not synthesize app build workflows for generation prompts", async () => {
  const client = new MockModelClient();
  const output = await client.completeJson<PlannerModelOutput>({
    model: "mock-planner",
    schemaName: "planner_v1",
    systemPrompt: "planner",
    userPrompt: JSON.stringify({
      userInput: "Create a React app on my Desktop and execute now."
    })
  });

  assert.equal(output.actions.length, 1);
  assert.equal(output.actions[0].type, "respond");
});

test("MockModelClient keeps live verification build prompts out of canned workflow synthesis", async () => {
  const client = new MockModelClient();
  const output = await client.completeJson<PlannerModelOutput>({
    model: "mock-planner",
    schemaName: "planner_v1",
    systemPrompt: "planner",
    userPrompt: JSON.stringify({
      userInput: "Create a React app on my Desktop, run the app, and verify the homepage UI. Execute now."
    })
  });

  assert.equal(output.actions.length, 1);
  assert.equal(output.actions[0].type, "respond");
});

test("MockModelClient planner prefers the current user request over wrapped conversation context", async () => {
  const client = new MockModelClient();
  const output = await client.completeJson<PlannerModelOutput>({
    model: "mock-planner",
    schemaName: "planner_v1",
    systemPrompt: "planner",
    userPrompt: JSON.stringify({
      userInput: [
        "Recent conversation context (oldest to newest):",
        "- User: Create a React app on my Desktop and execute now.",
        "",
        "Current user request:",
        "summarize what is currently running and what is queued right now."
      ].join("\n"),
      currentUserRequest: "summarize what is currently running and what is queued right now."
    })
  });

  assert.equal(output.actions.length, 1);
  assert.equal(output.actions[0].type, "respond");
  assert.equal(output.actions.some((action) => action.type === "shell_command"), false);
});

test("MockModelClient does not turn routed scaffold wording into canned build actions", async () => {
  const client = new MockModelClient();
  const output = await client.completeJson<PlannerModelOutput>({
    model: "mock-planner",
    schemaName: "planner_v1",
    systemPrompt: "planner",
    userPrompt: JSON.stringify({
      userInput: "Build and test a deterministic TypeScript CLI scaffold with runbook and tests."
    })
  });

  assert.equal(output.actions.length, 1);
  assert.equal(output.actions[0].type, "respond");
});

test("MockModelClient response synthesis uses the active request from wrapped conversation input", async () => {
  const client = new MockModelClient();
  const output = await client.completeJson<ResponseSynthesisModelOutput>({
    model: "mock-synthesizer",
    schemaName: "response_v1",
    systemPrompt: "synthesizer",
    userPrompt: JSON.stringify({
      userInput: [
        "Recent conversation context (oldest to newest):",
        "- User: Create a React app on my Desktop and execute now.",
        "",
        "Current user request:",
        "say currently running: none queued: one"
      ].join("\n")
    })
  });

  assert.equal(output.message, "currently running: none queued: one");
});

test("MockModelClient supports autonomous loop schemas", async () => {
  const client = new MockModelClient();
  const next = await client.completeJson<AutonomousNextStepModelOutput>({
    model: "mock-planner",
    schemaName: "autonomous_next_step_v1",
    systemPrompt: "autonomy",
    userPrompt: JSON.stringify({
      overarchingGoal: "improve docs"
    })
  });
  assert.equal(typeof next.isGoalMet, "boolean");
  assert.equal(typeof next.reasoning, "string");

  const proactive = await client.completeJson<ProactiveGoalModelOutput>({
    model: "mock-planner",
    schemaName: "proactive_goal_v1",
    systemPrompt: "autonomy",
    userPrompt: JSON.stringify({
      previousGoal: "goal"
    })
  });
  assert.equal(typeof proactive.proactiveGoal, "string");
});

test("MockModelClient supports response synthesis schema", async () => {
  const client = new MockModelClient();
  const output = await client.completeJson<ResponseSynthesisModelOutput>({
    model: "mock-synthesizer",
    schemaName: "response_v1",
    systemPrompt: "synthesizer",
    userPrompt: JSON.stringify({
      userInput: "tell me a sentence about space"
    })
  });

  assert.equal(typeof output.message, "string");
  assert.ok(output.message.toLowerCase().includes("space"));
});

test("MockModelClient supports intent interpretation schema", async () => {
  const client = new MockModelClient();
  const output = await client.completeJson<IntentInterpretationModelOutput>({
    model: "mock-intent",
    schemaName: "intent_interpretation_v1",
    systemPrompt: "intent",
    userPrompt: JSON.stringify({
      text: "Please stop pulse reminders for now."
    })
  });

  assert.equal(output.intentType, "pulse_control");
  assert.equal(output.mode, "off");
  assert.ok(output.confidence > 0.8);
});

test("MockModelClient supports bounded language episode extraction schema", async () => {
  const client = new MockModelClient();
  const output = await client.completeJson<LanguageEpisodeExtractionModelOutput>({
    model: "mock-language",
    schemaName: "language_episode_extraction_v1",
    systemPrompt: "language-understanding",
    userPrompt: JSON.stringify({
      text: [
        "Owen had this scare at the hospital a few weeks ago.",
        "We still do not know what the doctors found."
      ].join(" ")
    })
  });

  assert.equal(output.episodes.length, 1);
  assert.equal(output.episodes[0]?.subjectName, "Owen");
  assert.equal(output.episodes[0]?.eventSummary, "had a medical situation");
  assert.equal(output.episodes[0]?.status, "unresolved");
});

