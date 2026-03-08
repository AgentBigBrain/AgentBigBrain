/**
 * @fileoverview Tests success-side reflection lesson extraction behavior and fail-closed model handling.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ActionRunResult, TaskRunResult } from "../../src/core/types";
import {
  ModelClient,
  StructuredCompletionRequest,
  SuccessReflectionModelOutput
} from "../../src/models/types";
import { extractSuccessReflection } from "../../src/organs/reflectionRuntime/successLessons";

class RecordingSuccessModelClient implements ModelClient {
  readonly backend = "mock" as const;

  recordedRequest: StructuredCompletionRequest | null = null;

  constructor(private readonly output: SuccessReflectionModelOutput) {}

  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    this.recordedRequest = request;
    return this.output as T;
  }
}

class FailingSuccessModelClient implements ModelClient {
  readonly backend = "mock" as const;

  async completeJson<T>(_request: StructuredCompletionRequest): Promise<T> {
    throw new Error("forced success reflection failure");
  }
}

function buildRunResult(actionResults: ActionRunResult[]): TaskRunResult {
  const nowIso = new Date().toISOString();
  return {
    task: {
      id: "task_reflection_success_extract",
      goal: "Capture the operational insight that made the task succeed.",
      userInput: "Explain the successful approach.",
      createdAt: nowIso
    },
    plan: {
      taskId: "task_reflection_success_extract",
      plannerNotes: "reflection success test",
      actions: actionResults.map((result) => result.action)
    },
    actionResults,
    summary: "reflection success summary",
    startedAt: nowIso,
    completedAt: nowIso
  };
}

test("extractSuccessReflection sends approved action evidence through the success schema", async () => {
  const approvedActions: ActionRunResult[] = [
    {
      action: {
        id: "approved_respond_action",
        type: "respond",
        description: "reply with grounded summary",
        params: {},
        estimatedCostUsd: 0.01
      },
      mode: "fast_path",
      approved: true,
      blockedBy: [],
      violations: [],
      votes: []
    }
  ];
  const runResult = buildRunResult(approvedActions);
  const modelClient = new RecordingSuccessModelClient({
    lesson: "Ground the reply in the approved action trail before summarizing it.",
    nearMiss: "The final summary almost omitted the approved action evidence."
  });

  const output = await extractSuccessReflection(modelClient, runResult, "mock-reflection");

  assert.deepEqual(output, {
    lesson: "Ground the reply in the approved action trail before summarizing it.",
    nearMiss: "The final summary almost omitted the approved action evidence."
  });
  assert.equal(modelClient.recordedRequest?.schemaName, "reflection_success_v1");
  assert.equal(modelClient.recordedRequest?.model, "mock-reflection");
  assert.match(modelClient.recordedRequest?.userPrompt ?? "", /reply with grounded summary/);
});

test("extractSuccessReflection fails closed when the success reflection model errors", async () => {
  const approvedActions: ActionRunResult[] = [
    {
      action: {
        id: "approved_read_action",
        type: "read_file",
        description: "read runtime state",
        params: { path: "runtime/state.json" },
        estimatedCostUsd: 0.02
      },
      mode: "fast_path",
      approved: true,
      blockedBy: [],
      violations: [],
      votes: []
    }
  ];

  const output = await extractSuccessReflection(
    new FailingSuccessModelClient(),
    buildRunResult(approvedActions),
    "mock-reflection"
  );

  assert.equal(output, null);
});
