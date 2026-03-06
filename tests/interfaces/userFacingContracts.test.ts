/**
 * @fileoverview Validates deterministic UserFacingEnvelopeV1 rendering and TruthPolicyV1 summary invariants.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { TaskRunResult } from "../../src/core/types";
import {
  applyTruthPolicyV1ToOutcomeSummary,
  buildUserFacingEnvelopeV1,
  renderUserFacingEnvelopeV1
} from "../../src/interfaces/userFacingContracts";

/**
 * Implements `buildMinimalRunResult` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildMinimalRunResult(approved: number, blocked: number): TaskRunResult {
  const now = "2026-03-01T12:00:00.000Z";
  const actionResults: TaskRunResult["actionResults"] = [];
  for (let index = 0; index < approved; index += 1) {
    actionResults.push({
      action: {
        id: `approved_${index}`,
        type: "respond",
        description: "approved respond",
        params: { message: "ok" },
        estimatedCostUsd: 0.01
      },
      mode: "fast_path",
      approved: true,
      output: "ok",
      blockedBy: [],
      violations: [],
      votes: []
    });
  }
  for (let index = 0; index < blocked; index += 1) {
    actionResults.push({
      action: {
        id: `blocked_${index}`,
        type: "write_file",
        description: "blocked write",
        params: { path: "runtime/file.txt", content: "blocked" },
        estimatedCostUsd: 0.02
      },
      mode: "escalation_path",
      approved: false,
      output: "",
      blockedBy: ["WRITE_PROTECTED_PATH"],
      violations: [],
      votes: []
    });
  }
  return {
    task: {
      id: "task_test",
      goal: "test truth policy",
      userInput: "Show what will run and what ran.",
      createdAt: now
    },
    plan: {
      taskId: "task_test",
      plannerNotes: "test",
      actions: actionResults.map((result) => result.action)
    },
    actionResults,
    summary: "Completed task with 0 approved action(s) and 1 blocked action(s).",
    startedAt: now,
    completedAt: now
  };
}

test("renderUserFacingEnvelopeV1 renders deterministic no-op template shape", () => {
  const envelope = buildUserFacingEnvelopeV1(
    "NO_OP",
    "I couldn't execute that side-effect in this run.",
    "BUILD_NO_SIDE_EFFECT_EXECUTED",
    "Request approval diff."
  );
  const rendered = renderUserFacingEnvelopeV1(envelope);
  assert.match(rendered, /What happened:\s*this run finished without executing the requested side effect\./i);
  assert.match(rendered, /Why it didn't execute:/i);
  assert.match(rendered, /Technical reason code:\s*BUILD_NO_SIDE_EFFECT_EXECUTED/i);
  assert.match(rendered, /What to do next:\s*Request approval diff\./i);
});

test("applyTruthPolicyV1ToOutcomeSummary removes completion wording for blocked outcomes", () => {
  const runResult = buildMinimalRunResult(0, 1);
  const normalized = applyTruthPolicyV1ToOutcomeSummary(
    "Completed task with 0 approved action(s) and 1 blocked action(s).",
    runResult
  );
  assert.equal(
    normalized,
    "Task ended blocked with 0 approved action(s) and 1 blocked action(s)."
  );
});
