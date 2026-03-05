/**
 * @fileoverview Tests deterministic workflow-learning persistence, retrieval, and observation extraction.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  deriveWorkflowObservationFromTaskRun,
  WorkflowLearningStore
} from "../../src/core/workflowLearningStore";
import { TaskRunResult } from "../../src/core/types";

/**
 * Creates a deterministic task-run fixture for workflow-learning tests.
 */
function buildRunResult(userInput: string): TaskRunResult {
  return {
    task: {
      id: "task_workflow_learning_fixture",
      goal: "Summarize deterministic workflow behavior.",
      userInput,
      createdAt: "2026-03-03T00:00:00.000Z"
    },
    plan: {
      taskId: "task_workflow_learning_fixture",
      plannerNotes: "fixture",
      actions: [
        {
          id: "action_1",
          type: "respond",
          description: "Respond to user.",
          params: {
            message: "ok"
          },
          estimatedCostUsd: 0.01
        }
      ]
    },
    actionResults: [
      {
        action: {
          id: "action_1",
          type: "respond",
          description: "Respond to user.",
          params: {
            message: "ok"
          },
          estimatedCostUsd: 0.01
        },
        mode: "fast_path",
        approved: true,
        output: "ok",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    summary: "completed",
    startedAt: "2026-03-03T00:00:01.000Z",
    completedAt: "2026-03-03T00:00:02.000Z"
  };
}

/**
 * Executes a callback with a temporary workflow-learning runtime directory.
 */
async function withWorkflowLearningStore(
  callback: (paths: { filePath: string; sqlitePath: string }) => Promise<void>
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbb-workflow-learning-"));
  try {
    await callback({
      filePath: path.join(tempDir, "workflow_learning.json"),
      sqlitePath: path.join(tempDir, "ledgers.sqlite")
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("workflow store records observations and returns deterministic relevant hints", async () => {
  await withWorkflowLearningStore(async ({ filePath }) => {
    const store = new WorkflowLearningStore(filePath);
    await store.recordObservation({
      workflowKey: "respond+read_file:release_summary",
      outcome: "success",
      observedAt: "2026-03-03T00:00:00.000Z",
      domainLane: "workflow",
      contextTags: ["release", "summary"]
    });
    await store.recordObservation({
      workflowKey: "respond+read_file:release_summary",
      outcome: "success",
      observedAt: "2026-03-03T00:01:00.000Z",
      domainLane: "workflow",
      contextTags: ["release", "summary"]
    });
    await store.recordObservation({
      workflowKey: "respond+run_skill:latency_probe",
      outcome: "failure",
      observedAt: "2026-03-03T00:02:00.000Z",
      domainLane: "workflow",
      contextTags: ["latency", "probe"]
    });

    const hints = await store.getRelevantPatterns("need release summary", 2);
    assert.equal(hints.length, 2);
    assert.match(hints[0]?.workflowKey ?? "", /release_summary/i);
    assert.equal(hints[0]?.status, "active");
    assert.equal(hints[0]?.successCount >= 2, true);
    assert.equal(hints[0]?.failureCount, 0);
  });
});

test("workflow store maintains sqlite parity and JSON export on writes", async () => {
  await withWorkflowLearningStore(async ({ filePath, sqlitePath }) => {
    const sqliteStore = new WorkflowLearningStore(filePath, {
      backend: "sqlite",
      sqlitePath,
      exportJsonOnWrite: true
    });
    await sqliteStore.recordObservation({
      workflowKey: "respond+write_file:wiring_plan",
      outcome: "suppressed",
      observedAt: "2026-03-03T00:03:00.000Z",
      domainLane: "workflow",
      contextTags: ["wiring", "plan"]
    });

    const jsonStore = new WorkflowLearningStore(filePath);
    const jsonDocument = await jsonStore.load();
    assert.equal(jsonDocument.patterns.length, 1);
    assert.equal(jsonDocument.patterns[0]?.workflowKey, "respond+write_file:wiring_plan");
    assert.equal(jsonDocument.patterns[0]?.suppressedCount, 1);
  });
});

test("deriveWorkflowObservationFromTaskRun extracts active request and outcome deterministically", () => {
  const runResult = buildRunResult(
    [
      "You are in an ongoing conversation with the same user.",
      "Current user request:",
      "Please summarize release readiness status."
    ].join("\n")
  );
  const observation = deriveWorkflowObservationFromTaskRun(runResult);
  assert.match(observation.workflowKey, /respond:/i);
  assert.equal(observation.outcome, "success");
  assert.equal(observation.contextTags.includes("release"), true);
});
