/**
 * @fileoverview Tests deterministic reflection lesson-signal classification behavior and fail-closed duplicate filtering.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ActionRunResult, TaskRunResult } from "../../src/core/types";
import {
  classifyLessonSignal,
  LessonSignalRulepackV1
} from "../../src/organs/reflectionSignalClassifier";

/**
 * Implements `buildRunResult` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildRunResult(actionResults: ActionRunResult[]): TaskRunResult {
  const nowIso = new Date().toISOString();
  return {
    task: {
      id: "task_reflection_signal_classifier",
      goal: "Keep reflection lessons grounded in deterministic governance behavior.",
      userInput: "Analyze blocked sandbox actions and persist only useful lessons.",
      createdAt: nowIso
    },
    plan: {
      taskId: "task_reflection_signal_classifier",
      plannerNotes: "classifier test",
      actions: actionResults.map((result) => result.action)
    },
    actionResults,
    summary: "classifier test summary",
    startedAt: nowIso,
    completedAt: nowIso
  };
}

test("classifyLessonSignal rejects short lessons fail-closed", () => {
  const runResult = buildRunResult([
    {
      action: {
        id: "action_short_reject",
        type: "respond",
        description: "respond quickly",
        params: {},
        estimatedCostUsd: 0.01
      },
      mode: "fast_path",
      approved: true,
      output: "ok",
      blockedBy: [],
      violations: [],
      votes: []
    }
  ]);

  const result = classifyLessonSignal("too short", {
    runResult,
    source: "success",
    existingLessons: []
  });

  assert.equal(result.allowPersist, false);
  assert.equal(result.blockReason, "LESSON_TOO_SHORT");
  assert.equal(result.matchedRuleId, "lesson_signal_v1_too_short");
  assert.equal(result.rulepackVersion, LessonSignalRulepackV1.version);
});

test("classifyLessonSignal rejects low-signal generic communication lessons", () => {
  const runResult = buildRunResult([
    {
      action: {
        id: "action_low_signal_reject",
        type: "respond",
        description: "respond to user",
        params: {},
        estimatedCostUsd: 0.01
      },
      mode: "fast_path",
      approved: true,
      output: "ok",
      blockedBy: [],
      violations: [],
      votes: []
    }
  ]);

  const result = classifyLessonSignal(
    "Prioritizing user engagement through a friendly greeting enhances the overall user experience.",
    {
      runResult,
      source: "success",
      existingLessons: []
    }
  );

  assert.equal(result.allowPersist, false);
  assert.equal(result.blockReason, "LOW_SIGNAL_PATTERN");
  assert.equal(result.matchedRuleId, "lesson_signal_v1_low_signal_pattern");
});

test("classifyLessonSignal rejects localhost policy lessons that would poison later planning", () => {
  const runResult = buildRunResult([
    {
      action: {
        id: "action_localhost_policy_reject",
        type: "probe_http",
        description: "probe localhost readiness",
        params: {
          url: "http://127.0.0.1:3000/"
        },
        estimatedCostUsd: 0.02
      },
      mode: "fast_path",
      approved: false,
      blockedBy: ["PROBE_HTTP_FAILED"],
      violations: [{ code: "PROBE_HTTP_FAILED", message: "blocked" }],
      votes: []
    }
  ]);

  const result = classifyLessonSignal(
    "Automated probing of localhost or starting local servers may be blocked due to security and ethics policies; consider providing manual instructions for such steps.",
    {
      runResult,
      source: "failure",
      existingLessons: []
    }
  );

  assert.equal(result.allowPersist, false);
  assert.equal(result.blockReason, "LOW_SIGNAL_PATTERN");
  assert.equal(result.matchedRuleId, "lesson_signal_v1_low_signal_pattern");
});

test("classifyLessonSignal allows high-signal governance lessons", () => {
  const runResult = buildRunResult([
    {
      action: {
        id: "action_high_signal_allow",
        type: "create_skill",
        description: "create sandboxed skill",
        params: {
          name: "deterministic_guard",
          code: "export function run(): string { return 'ok'; }"
        },
        estimatedCostUsd: 0.2
      },
      mode: "escalation_path",
      approved: true,
      output: "done",
      blockedBy: [],
      violations: [],
      votes: []
    }
  ]);

  const result = classifyLessonSignal(
    "Validate create_skill payload against policy constraints before promotion to prevent unsafe code merges.",
    {
      runResult,
      source: "success",
      existingLessons: []
    }
  );

  assert.equal(result.allowPersist, true);
  assert.equal(result.blockReason, null);
  assert.equal(result.matchedRuleId, "lesson_signal_v1_allow_high_signal_keyword");
});

test("classifyLessonSignal rejects near-duplicate lessons deterministically", () => {
  const runResult = buildRunResult([
    {
      action: {
        id: "action_duplicate_reject",
        type: "delete_file",
        description: "delete target file",
        params: { path: "runtime/sandbox/file.txt" },
        estimatedCostUsd: 0.05
      },
      mode: "escalation_path",
      approved: false,
      blockedBy: ["DELETE_OUTSIDE_SANDBOX"],
      violations: [{ code: "DELETE_OUTSIDE_SANDBOX", message: "blocked" }],
      votes: []
    }
  ]);

  const result = classifyLessonSignal(
    "Ensure delete actions validate sandbox paths before execution.",
    {
      runResult,
      source: "failure",
      existingLessons: [
        "Validate sandbox path before delete action execution to prevent escapes."
      ]
    }
  );

  assert.equal(result.allowPersist, false);
  assert.equal(result.blockReason, "NEAR_DUPLICATE");
  assert.equal(result.matchedRuleId, "lesson_signal_v1_near_duplicate");
  assert.ok(result.scores.maxSimilarity >= LessonSignalRulepackV1.lessonSimilarityThreshold);
});
