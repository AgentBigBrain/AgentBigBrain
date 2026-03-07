/**
 * @fileoverview Focused tests for user-facing block-surface rendering helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { TaskRunResult } from "../../../src/core/types";
import {
  extractBlockedPolicyCodes,
  resolveBlockedActionMessage
} from "../../../src/interfaces/userFacing/blockSurface";

function buildRunResult(
  actionResults: TaskRunResult["actionResults"],
  userInput = "Do the thing"
): TaskRunResult {
  return {
    task: {
      id: "task_block_surface_1",
      agentId: "main-agent",
      goal: "Reply to user",
      userInput,
      createdAt: new Date().toISOString()
    },
    plan: {
      taskId: "task_block_surface_1",
      plannerNotes: "test plan",
      actions: actionResults.map((item) => item.action)
    },
    actionResults,
    summary: "Task ended blocked.",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  };
}

test("resolveBlockedActionMessage explains identity impersonation blocks plainly", () => {
  const runResult = buildRunResult([
    {
      action: {
        id: "action_block_identity",
        type: "respond",
        description: "reply",
        params: {},
        estimatedCostUsd: 0.02
      },
      mode: "fast_path",
      approved: false,
      output: "",
      blockedBy: ["IDENTITY_IMPERSONATION_DENIED"],
      violations: [],
      votes: []
    }
  ]);

  const policyCodes = extractBlockedPolicyCodes(runResult);
  const message = resolveBlockedActionMessage(runResult, policyCodes, {
    showSafetyCodes: false
  });

  assert.deepEqual(policyCodes, ["IDENTITY_IMPERSONATION_DENIED"]);
  assert.ok(message);
  assert.match(message!, /identity policy requires me to stay explicitly AI/i);
  assert.doesNotMatch(message!, /Technical reason code:/i);
});

test("resolveBlockedActionMessage humanizes live-build policy blocks", () => {
  const runResult = buildRunResult(
    [
      {
        action: {
          id: "action_block_process",
          type: "start_process",
          description: "start dev server",
          params: {
            cmd: "npm run dev"
          },
          estimatedCostUsd: 0.2
        },
        mode: "escalation_path",
        approved: false,
        output: "",
        blockedBy: ["PROCESS_DISABLED_BY_POLICY"],
        violations: [],
        votes: []
      }
    ],
    "Create a tiny app, start it, and verify the homepage UI in a real browser."
  );

  const policyCodes = extractBlockedPolicyCodes(runResult);
  const message = resolveBlockedActionMessage(runResult, policyCodes, {
    showSafetyCodes: true
  });

  assert.ok(message);
  assert.match(message!, /couldn't start the requested live app run/i);
  assert.match(message!, /PROCESS_DISABLED_BY_POLICY/i);
});
