/**
 * @fileoverview Covers autonomous conversation execution result aggregation for session ledgers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { TaskRunResult } from "../../src/core/types";
import { buildAutonomousConversationExecutionResult } from "../../src/interfaces/autonomousConversationExecutionResult";

function buildTaskRunResult(
  overrides: Partial<TaskRunResult> = {}
): TaskRunResult {
  return {
    task: {
      id: "task-autonomous-1",
      goal: "Build and open the landing page.",
      userInput: "Build the landing page and leave it open.",
      createdAt: "2026-03-13T12:00:00.000Z"
    },
    plan: {
      taskId: "task-autonomous-1",
      plannerNotes: "Write files and open the browser.",
      actions: []
    },
    actionResults: [],
    summary: "Completed.",
    startedAt: "2026-03-13T12:00:01.000Z",
    completedAt: "2026-03-13T12:00:02.000Z",
    ...overrides
  };
}

test("buildAutonomousConversationExecutionResult preserves aggregated action history for session ledgers", () => {
  const latestTaskRunResult = buildTaskRunResult({
    actionResults: [
      {
        action: {
          id: "action_open_browser",
          type: "open_browser",
          description: "Open the verified page in a visible browser window.",
          params: {
            url: "http://127.0.0.1:4177/index.html"
          },
          estimatedCostUsd: 0.03
        },
        mode: "escalation_path",
        approved: true,
        output: "Opened the page in your browser.",
        executionStatus: "success",
        executionMetadata: {
          browserSessionId: "browser_session:landing-page",
          browserSessionUrl: "http://127.0.0.1:4177/index.html",
          browserSessionStatus: "open"
        },
        blockedBy: [],
        violations: [],
        votes: []
      }
    ]
  });

  const aggregatedActionResults: TaskRunResult["actionResults"] = [
    {
      action: {
        id: "action_write_file",
        type: "write_file",
        description: "Write index.html into the Desktop workspace.",
        params: {
          path: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
          content: "<!doctype html><title>Sample Company</title>"
        },
        estimatedCostUsd: 0.08
      },
      mode: "escalation_path",
      approved: true,
      output: "Write success: C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
      executionStatus: "success",
      executionMetadata: {
        filePath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html"
      },
      blockedBy: [],
      violations: [],
      votes: []
    },
    ...latestTaskRunResult.actionResults
  ];

  const executionResult = buildAutonomousConversationExecutionResult(
    "Autonomous task completed after 1 iteration.",
    latestTaskRunResult,
    aggregatedActionResults,
    "2026-03-13T12:00:01.000Z",
    "2026-03-13T12:00:03.000Z"
  );

  assert.equal(
    executionResult.summary,
    "Autonomous task completed after 1 iteration."
  );
  assert.ok(executionResult.taskRunResult);
  assert.equal(executionResult.taskRunResult?.actionResults.length, 2);
  assert.equal(
    executionResult.taskRunResult?.actionResults[0]?.action.type,
    "write_file"
  );
  assert.equal(
    executionResult.taskRunResult?.actionResults[1]?.action.type,
    "open_browser"
  );
  assert.equal(
    executionResult.taskRunResult?.completedAt,
    "2026-03-13T12:00:03.000Z"
  );
});

test("buildAutonomousConversationExecutionResult appends the latest concrete task summary when the autonomous wrapper is generic", () => {
  const latestTaskRunResult = buildTaskRunResult({
    summary:
      "Checked 2 matching folders under C:\\Users\\testuser\\Desktop. Stopped 2 exact server processes and verified that no matching local server processes remain listening."
  });

  const executionResult = buildAutonomousConversationExecutionResult(
    "Autonomous task completed after 1 iteration.",
    latestTaskRunResult,
    latestTaskRunResult.actionResults,
    "2026-03-13T12:00:01.000Z",
    "2026-03-13T12:00:03.000Z"
  );

  assert.equal(
    executionResult.summary,
    [
      "Autonomous task completed after 1 iteration.",
      "Checked 2 matching folders under C:\\Users\\testuser\\Desktop. Stopped 2 exact server processes and verified that no matching local server processes remain listening."
    ].join("\n")
  );
  assert.equal(executionResult.taskRunResult?.summary, executionResult.summary);
});

test("buildAutonomousConversationExecutionResult falls back to concise approved action outputs when the task summary is generic", () => {
  const latestTaskRunResult = buildTaskRunResult({
    summary: "Completed task with 1 approved action(s) and 0 blocked action(s) across 1 plan attempt(s).",
    actionResults: [
      {
        action: {
          id: "action_stop_folder_runtime_processes",
          type: "stop_folder_runtime_processes",
          description: "Stop exact listening server processes for matching Desktop sample folders.",
          params: {
            rootPath: "C:\\Users\\testuser\\Desktop",
            selectorMode: "starts_with",
            selectorTerm: "sample"
          },
          estimatedCostUsd: 0.14
        },
        mode: "escalation_path",
        approved: true,
        output:
          "Checked 2 matching folders under C:\\Users\\testuser\\Desktop. Stopped 2 exact server processes: pid 4552 port 4173 folder C:\\Users\\testuser\\Desktop\\sample-alpha; pid 4556 port 4174 folder C:\\Users\\testuser\\Desktop\\Sample-beta. Verified that no matching local server processes remain listening.",
        executionStatus: "success",
        executionMetadata: {
          folderRuntimeProcessSweep: true
        },
        blockedBy: [],
        violations: [],
        votes: []
      }
    ]
  });

  const executionResult = buildAutonomousConversationExecutionResult(
    "Autonomous task completed after 1 iteration.",
    latestTaskRunResult,
    latestTaskRunResult.actionResults,
    "2026-03-13T12:00:01.000Z",
    "2026-03-13T12:00:03.000Z"
  );

  assert.match(
    executionResult.summary,
    /Checked 2 matching folders under C:\\Users\\testuser\\Desktop\./
  );
  assert.match(
    String(executionResult.taskRunResult?.summary ?? ""),
    /Verified that no matching local server processes remain listening\./
  );
});
