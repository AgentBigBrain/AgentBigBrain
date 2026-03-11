/**
 * @fileoverview Covers canonical workflow-learning extraction, ranking, planner bias, and inspection helpers.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildWorkflowPlannerBias, renderWorkflowPlannerBiasGuidance } from "../../src/core/workflowLearningRuntime/plannerBias";
import { deriveWorkflowObservationFromTaskRunDetailed } from "../../src/core/workflowLearningRuntime/observationExtraction";
import { rankRelevantWorkflowPatterns } from "../../src/core/workflowLearningRuntime/relevanceRanking";
import { summarizeWorkflowPatterns } from "../../src/core/workflowLearningRuntime/workflowInspection";
import type { ActionRunResult, PlannedAction, TaskRunResult, WorkflowPattern } from "../../src/core/types";

function buildPlannedAction(action: PlannedAction["type"], estimatedCostUsd = 0.02): PlannedAction {
  return {
    id: `action_${action}`,
    type: action,
    description: `${action} fixture`,
    params:
      action === "run_skill"
        ? { name: "triage_planner_failure", input: "planner failure" }
        : action === "read_file"
          ? { path: "src/organs/planner.ts" }
          : action === "respond"
            ? { message: "ok" }
            : {},
    estimatedCostUsd
  } as PlannedAction;
}

function buildActionResult(
  action: PlannedAction["type"],
  overrides: Partial<ActionRunResult> = {}
): ActionRunResult {
  return {
    action: buildPlannedAction(action),
    mode: "fast_path",
    approved: true,
    output: "ok",
    executionStatus: "success",
    blockedBy: [],
    violations: [],
    votes: [],
    ...overrides
  };
}

function buildRunResult(userInput: string): TaskRunResult {
  return {
    task: {
      id: "task_workflow_runtime_fixture",
      goal: "Summarize deterministic workflow behavior.",
      userInput,
      createdAt: "2026-03-10T10:00:00.000Z"
    },
    plan: {
      taskId: "task_workflow_runtime_fixture",
      plannerNotes: "fixture",
      actions: [
        buildPlannedAction("read_file"),
        buildPlannedAction("run_skill"),
        buildPlannedAction("respond")
      ]
    },
    actionResults: [
      buildActionResult("read_file", { output: "planner contents" }),
      buildActionResult("run_skill", {
        output: "triaged: planner action mismatch",
        executionMetadata: {
          skillName: "triage_planner_failure",
          skillVerificationStatus: "verified",
          skillTrustedForReuse: true
        }
      }),
      buildActionResult("respond", { output: "done" })
    ],
    summary: "completed",
    startedAt: "2026-03-10T10:00:01.000Z",
    completedAt: "2026-03-10T10:00:03.000Z"
  };
}

function buildWorkflowPattern(
  workflowKey: string,
  overrides: Partial<WorkflowPattern> = {}
): WorkflowPattern {
  return {
    id: `pattern_${workflowKey.replace(/[^a-z0-9]+/gi, "_")}`,
    workflowKey,
    status: "active",
    confidence: 0.7,
    firstSeenAt: "2026-03-10T09:00:00.000Z",
    lastSeenAt: "2026-03-10T10:00:00.000Z",
    supersededAt: null,
    domainLane: "workflow",
    successCount: 3,
    failureCount: 0,
    suppressedCount: 0,
    contextTags: ["planner", "triage"],
    executionStyle: "skill_based",
    actionSequenceShape: "read_file>run_skill>respond",
    approvalPosture: "fast_path_only",
    verificationProofPresent: false,
    costBand: "low",
    latencyBand: "fast",
    dominantFailureMode: null,
    recoveryPath: "skill_reuse",
    linkedSkillName: "triage_planner_failure",
    linkedSkillVerificationStatus: "verified",
    ...overrides
  };
}

test("deriveWorkflowObservationFromTaskRunDetailed captures rich operational detail and linked skill metadata", () => {
  const observation = deriveWorkflowObservationFromTaskRunDetailed(
    buildRunResult(
      [
        "You are in an ongoing conversation with the same user.",
        "Current user request:",
        "Please inspect the planner failure and reuse a proven skill if one already exists."
      ].join("\n")
    )
  );

  assert.equal(observation.outcome, "success");
  assert.equal(observation.executionStyle, "skill_based");
  assert.equal(observation.actionSequenceShape, "read_file>run_skill>respond");
  assert.equal(observation.approvalPosture, "fast_path_only");
  assert.equal(observation.verificationProofPresent, false);
  assert.equal(observation.costBand, "low");
  assert.equal(observation.latencyBand, "fast");
  assert.equal(observation.recoveryPath, "skill_reuse");
  assert.equal(observation.linkedSkillName, "triage_planner_failure");
  assert.equal(observation.linkedSkillVerificationStatus, "verified");
  assert.ok(observation.contextTags.includes("planner"));
});

test("rankRelevantWorkflowPatterns prefers structured overlap and verified linked skills", () => {
  const ranked = rankRelevantWorkflowPatterns(
    [
      buildWorkflowPattern("read_file+run_skill:planner_triage", {
        confidence: 0.82,
        linkedSkillName: "triage_planner_failure",
        linkedSkillVerificationStatus: "verified",
        contextTags: ["planner", "triage"]
      }),
      buildWorkflowPattern("respond+read_file:release_summary", {
        confidence: 0.75,
        executionStyle: "multi_action",
        actionSequenceShape: "read_file>respond",
        linkedSkillName: null,
        linkedSkillVerificationStatus: null,
        contextTags: ["release", "summary"],
        recoveryPath: null
      }),
      buildWorkflowPattern("read_file+respond:docs_refresh", {
        confidence: 0.52,
        executionStyle: "multi_action",
        actionSequenceShape: "read_file>respond",
        linkedSkillName: null,
        linkedSkillVerificationStatus: null,
        contextTags: ["docs", "refresh"],
        recoveryPath: null
      })
    ],
    "Need the best planner triage skill for this failing workflow",
    2
  );

  assert.equal(ranked.length, 2);
  assert.equal(ranked[0]?.workflowKey, "read_file+run_skill:planner_triage");
  assert.equal(ranked[0]?.linkedSkillVerificationStatus, "verified");
});

test("workflow planner bias and inspection expose preferred, discouraged, and linked skill details", () => {
  const patterns = [
    buildWorkflowPattern("read_file+run_skill:planner_triage", {
      confidence: 0.82,
      successCount: 4,
      failureCount: 1
    }),
    buildWorkflowPattern("probe_http+verify_browser:ui_check", {
      confidence: 0.34,
      executionStyle: "live_run",
      actionSequenceShape: "probe_http>verify_browser>respond",
      successCount: 1,
      failureCount: 3,
      suppressedCount: 2,
      linkedSkillName: null,
      linkedSkillVerificationStatus: null,
      contextTags: ["ui", "browser"],
      recoveryPath: "browser_verification_recovery",
      lastSeenAt: "2026-03-10T10:05:00.000Z"
    })
  ];
  const bias = buildWorkflowPlannerBias(patterns);
  const guidance = renderWorkflowPlannerBiasGuidance(bias);
  const inspection = summarizeWorkflowPatterns(patterns);

  assert.equal(bias.preferredPatterns[0]?.workflowKey, "read_file+run_skill:planner_triage");
  assert.equal(bias.discouragedPatterns[0]?.workflowKey, "probe_http+verify_browser:ui_check");
  assert.match(guidance, /Preferred workflow motifs:/);
  assert.match(guidance, /prefer verified skill triage_planner_failure/i);
  assert.match(guidance, /Avoid degraded workflow motifs:/);
  assert.equal(inspection[0]?.workflowKey, "probe_http+verify_browser:ui_check");
  assert.equal(inspection[1]?.linkedSkillName, "triage_planner_failure");
});
