/**
 * @fileoverview Tests failure-side reflection lesson extraction behavior and fail-closed model handling.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ActionRunResult, TaskRunResult } from "../../src/core/types";
import {
  ModelClient,
  ReflectionModelOutput,
  StructuredCompletionRequest
} from "../../src/models/types";
import { extractFailureLessons } from "../../src/organs/reflectionRuntime/failureLessons";

class RecordingFailureModelClient implements ModelClient {
  readonly backend = "mock" as const;

  recordedRequest: StructuredCompletionRequest | null = null;

  constructor(private readonly output: ReflectionModelOutput) {}

  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    this.recordedRequest = request;
    return this.output as T;
  }
}

class FailingFailureModelClient implements ModelClient {
  readonly backend = "mock" as const;

  async completeJson<T>(_request: StructuredCompletionRequest): Promise<T> {
    throw new Error("forced reflection failure");
  }
}

function buildRunResult(actionResults: ActionRunResult[]): TaskRunResult {
  const nowIso = new Date().toISOString();
  return {
    task: {
      id: "task_reflection_failure_extract",
      goal: "Learn from blocked shell and delete actions.",
      userInput: "Try the blocked action and explain the failure.",
      createdAt: nowIso
    },
    plan: {
      taskId: "task_reflection_failure_extract",
      plannerNotes: "reflection failure test",
      actions: actionResults.map((result) => result.action)
    },
    actionResults,
    summary: "reflection failure summary",
    startedAt: nowIso,
    completedAt: nowIso
  };
}

test("extractFailureLessons sends blocked action evidence through the reflection schema", async () => {
  const blockedActions: ActionRunResult[] = [
    {
      action: {
        id: "blocked_shell_action",
        type: "shell_command",
        description: "run shell command",
        params: { command: "echo hi" },
        estimatedCostUsd: 0.1
      },
      mode: "escalation_path",
      approved: false,
      blockedBy: ["SHELL_DISABLED_BY_POLICY"],
      violations: [{ code: "SHELL_DISABLED_BY_POLICY", message: "blocked" }],
      votes: []
    }
  ];
  const runResult = buildRunResult(blockedActions);
  const modelClient = new RecordingFailureModelClient({
    lessons: ["Validate shell policy before attempting command execution."]
  });

  const lessons = await extractFailureLessons(
    modelClient,
    runResult,
    blockedActions,
    "mock-reflection"
  );

  assert.deepEqual(lessons, ["Validate shell policy before attempting command execution."]);
  assert.equal(modelClient.recordedRequest?.schemaName, "reflection_v1");
  assert.equal(modelClient.recordedRequest?.model, "mock-reflection");
  assert.match(modelClient.recordedRequest?.userPrompt ?? "", /SHELL_DISABLED_BY_POLICY/);
  assert.match(modelClient.recordedRequest?.userPrompt ?? "", /run shell command/);
});

test("extractFailureLessons fails closed when the reflection model errors", async () => {
  const blockedActions: ActionRunResult[] = [
    {
      action: {
        id: "blocked_delete_action",
        type: "delete_file",
        description: "delete file",
        params: { path: "C:/unsafe.txt" },
        estimatedCostUsd: 0.1
      },
      mode: "escalation_path",
      approved: false,
      blockedBy: ["DELETE_OUTSIDE_SANDBOX"],
      violations: [{ code: "DELETE_OUTSIDE_SANDBOX", message: "blocked" }],
      votes: []
    }
  ];

  const lessons = await extractFailureLessons(
    new FailingFailureModelClient(),
    buildRunResult(blockedActions),
    blockedActions,
    "mock-reflection"
  );

  assert.equal(lessons, null);
});
