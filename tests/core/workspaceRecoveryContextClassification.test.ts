import assert from "node:assert/strict";
import { test } from "node:test";

import { isLocalOrganizationRecoveryContext } from "../../src/core/autonomy/workspaceRecoveryContextClassification";
import type { TaskRunResult } from "../../src/core/types";

function buildTaskRunResult(task: {
  goal: string;
  userInput: string;
}): TaskRunResult {
  return {
    task: {
      id: "task_workspace_recovery_context",
      goal: task.goal,
      userInput: task.userInput,
      createdAt: "2026-04-13T05:30:00.000Z"
    },
    plan: {
      taskId: "task_workspace_recovery_context",
      plannerNotes: "context classification regression",
      actions: []
    },
    actionResults: [],
    summary: "",
    startedAt: "2026-04-13T05:30:01.000Z",
    completedAt: "2026-04-13T05:30:02.000Z"
  };
}

test("isLocalOrganizationRecoveryContext keys workspace recovery off the original goal", () => {
  const result = buildTaskRunResult({
    goal:
      "Move every drone-company project folder into a folder called drone-web-projects on my desktop.",
    userInput:
      "Inspect the exact workspace resources first, then stop only the exact holders and retry the move."
  });

  assert.equal(isLocalOrganizationRecoveryContext(result), true);
});

test("isLocalOrganizationRecoveryContext does not misclassify shutdown inspection prompts as folder recovery", () => {
  const result = buildTaskRunResult({
    goal: "Close Foundry Echo, shut down the local preview, and close the browser window end to end.",
    userInput:
      "Collect stronger shutdown evidence before any success claim. Inspect all available runtime/process and browser/session resources again, including local servers, app processes, and any browser tab tied to the preview."
  });

  assert.equal(isLocalOrganizationRecoveryContext(result), false);
});
