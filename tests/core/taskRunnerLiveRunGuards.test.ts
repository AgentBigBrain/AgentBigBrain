import assert from "node:assert/strict";
import { test } from "node:test";

import type { ActionRunResult, PlannedAction } from "../../src/core/types";
import {
  evaluateDependentWorkspaceExecutionBlock,
  rememberFailedWorkspaceExecutionDependency
} from "../../src/core/orchestration/taskRunnerLiveRunGuards";

function buildShellAction(
  id: string,
  command: string,
  cwd: string
): PlannedAction {
  return {
    id,
    type: "shell_command",
    description: command,
    params: {
      command,
      cwd,
      workdir: cwd
    },
    estimatedCostUsd: 0.1
  };
}

function buildFailedActionResult(action: PlannedAction): ActionRunResult {
  return {
    action,
    mode: "escalation_path",
    approved: false,
    output: "Shell failed.",
    executionStatus: "failed",
    executionFailureCode: "ACTION_EXECUTION_FAILED",
    blockedBy: ["ACTION_EXECUTION_FAILED"],
    violations: [
      {
        code: "ACTION_EXECUTION_FAILED",
        message: "Shell failed."
      }
    ],
    votes: []
  };
}

test("rememberFailedWorkspaceExecutionDependency records failed npm install prerequisites", () => {
  const workspaceRoot = "C:\\Users\\testuser\\Desktop\\Detroit City";
  const failedInstall = buildFailedActionResult(
    buildShellAction("action_install", "npm install", workspaceRoot)
  );

  const remembered = rememberFailedWorkspaceExecutionDependency([], failedInstall);

  assert.deepEqual(remembered, [
    {
      workspaceRoot,
      sourceActionId: "action_install",
      failureCode: "ACTION_EXECUTION_FAILED",
      stage: "install"
    }
  ]);
});

test("evaluateDependentWorkspaceExecutionBlock blocks later build and preview steps after failed install", () => {
  const workspaceRoot = "C:\\Users\\testuser\\Desktop\\Detroit City";
  const failedDependencies = rememberFailedWorkspaceExecutionDependency(
    [],
    buildFailedActionResult(buildShellAction("action_install", "npm install", workspaceRoot))
  );

  const blockedBuild = evaluateDependentWorkspaceExecutionBlock(
    buildShellAction("action_build", "npm run build", workspaceRoot),
    "escalation_path",
    failedDependencies
  );
  const blockedPreview = evaluateDependentWorkspaceExecutionBlock(
    {
      id: "action_preview",
      type: "probe_http",
      description: "Wait for localhost readiness.",
      params: {
        url: "http://127.0.0.1:3000"
      },
      estimatedCostUsd: 0.03
    },
    "escalation_path",
    failedDependencies
  );

  assert.equal(blockedBuild?.actionResult.approved, false);
  assert.deepEqual(blockedBuild?.actionResult.blockedBy, ["ACTION_EXECUTION_FAILED"]);
  assert.match(
    blockedBuild?.actionResult.output ?? "",
    /earlier framework workspace prerequisite failed/i
  );
  assert.equal(
    blockedBuild?.actionResult.executionMetadata?.liveRunDependencyWorkspaceRoot,
    workspaceRoot
  );
  assert.equal(blockedPreview?.actionResult.approved, false);
  assert.equal(
    blockedPreview?.actionResult.executionMetadata?.liveRunDependencyStage,
    "install"
  );
});
