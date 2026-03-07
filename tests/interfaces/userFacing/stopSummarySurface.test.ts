/**
 * @fileoverview Focused tests for stop-summary and terminal summary helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { TaskRunResult } from "../../../src/core/types";
import {
  buildAutonomousGoalAbortedProgressMessage,
  buildAutonomousTerminalSummaryMessage,
  isRunSkillFailureLine,
  resolveSummaryFallback
} from "../../../src/interfaces/userFacing/stopSummarySurface";

function buildRunResult(
  summary: string,
  actionResults: TaskRunResult["actionResults"]
): TaskRunResult {
  return {
    task: {
      id: "task_stop_summary_1",
      agentId: "main-agent",
      goal: "Reply to user",
      userInput: "hello",
      createdAt: new Date().toISOString()
    },
    plan: {
      taskId: "task_stop_summary_1",
      plannerNotes: "test plan",
      actions: actionResults.map((item) => item.action)
    },
    actionResults,
    summary,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  };
}

test("resolveSummaryFallback collapses completed technical summaries when debug summary is hidden", () => {
  const runResult = buildRunResult("Completed task with 1 approved action(s).", [
    {
      action: {
        id: "action_write_done",
        type: "write_file",
        description: "write a file",
        params: { path: "README.md" },
        estimatedCostUsd: 0.05
      },
      mode: "fast_path",
      approved: true,
      output: "Wrote README.md",
      blockedBy: [],
      violations: [],
      votes: []
    }
  ]);

  const summary = resolveSummaryFallback(runResult, runResult.summary, {
    showTechnicalSummary: false,
    showSafetyCodes: false
  });

  assert.equal(summary, "Done.");
});

test("buildAutonomousGoalAbortedProgressMessage includes actionable stop guidance", () => {
  const reason =
    "[reasonCode=AUTONOMOUS_TASK_EXECUTION_FAILED] Planner model returned no live-verification actions for execution-style live-run request.";

  const message = buildAutonomousGoalAbortedProgressMessage(3, 2, 1, reason);

  assert.match(message, /planner never produced a valid live-run verification plan/i);
  assert.match(message, /Next step:/i);
});

test("buildAutonomousTerminalSummaryMessage reuses humanized stop text", () => {
  const reason =
    "[reasonCode=AUTONOMOUS_EXECUTION_STYLE_STALLED_NO_SIDE_EFFECT] Missing requirement\\(s\\): BROWSER_PROOF.";

  const message = buildAutonomousTerminalSummaryMessage(false, 4, 2, 2, reason);

  assert.match(message, /Why it stopped:/i);
  assert.match(message, /browser or UI proof/i);
  assert.equal(isRunSkillFailureLine("Run skill failed: artifact missing."), true);
});
