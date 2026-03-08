/**
 * @fileoverview Tests canonical mock planner-response builders.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPlannerOutput } from "../../src/models/mock/plannerResponses";

test("buildPlannerOutput emits managed-process readiness actions for live verification prompts", () => {
  const output = buildPlannerOutput(
    JSON.stringify({
      userInput: "Create a React app on my Desktop, run the app, and verify the homepage UI. Execute now."
    })
  );

  assert.ok(output.actions.some((action) => action.type === "shell_command"));
  assert.ok(output.actions.some((action) => action.type === "start_process"));
  assert.ok(output.actions.some((action) => action.type === "probe_port"));
  assert.ok(output.actions.some((action) => action.type === "verify_browser"));
});

test("buildPlannerOutput prefers the current user request over wrapped context", () => {
  const output = buildPlannerOutput(
    JSON.stringify({
      userInput: [
        "Recent conversation context (oldest to newest):",
        "- User: Create a React app on my Desktop and execute now.",
        "",
        "Current user request:",
        "summarize what is currently running and what is queued right now."
      ].join("\n"),
      currentUserRequest: "summarize what is currently running and what is queued right now."
    })
  );

  assert.equal(output.actions.length, 1);
  assert.equal(output.actions[0].type, "respond");
});
