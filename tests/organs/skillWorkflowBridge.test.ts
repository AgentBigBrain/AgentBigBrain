/**
 * @fileoverview Covers the deterministic bridge between workflow motifs and governed skill reuse.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildWorkflowSkillBridgeSummary } from "../../src/organs/skillRegistry/workflowSkillBridge";
import type { SkillInventoryEntry, SkillVerificationStatus } from "../../src/organs/skillRegistry/contracts";
import type { WorkflowPattern } from "../../src/core/types";

function buildWorkflowPattern(
  workflowKey: string,
  overrides: Partial<WorkflowPattern> = {}
): WorkflowPattern {
  return {
    id: `pattern_${workflowKey.replace(/[^a-z0-9]+/gi, "_")}`,
    workflowKey,
    status: "active",
    confidence: 0.82,
    firstSeenAt: "2026-03-10T10:00:00.000Z",
    lastSeenAt: "2026-03-10T11:00:00.000Z",
    supersededAt: null,
    domainLane: "workflow",
    successCount: 3,
    failureCount: 0,
    suppressedCount: 0,
    contextTags: ["planner", "tests"],
    executionStyle: "skill_based",
    actionSequenceShape: "read_file>run_skill>respond",
    approvalPosture: "fast_path_only",
    verificationProofPresent: true,
    costBand: "low",
    latencyBand: "fast",
    dominantFailureMode: null,
    recoveryPath: "skill_reuse",
    linkedSkillName: null,
    linkedSkillVerificationStatus: null,
    ...overrides
  };
}

function buildSkillEntry(
  name: string,
  verificationStatus: SkillVerificationStatus,
  overrides: Partial<SkillInventoryEntry> = {}
): SkillInventoryEntry {
  return {
    name,
    description: `Skill ${name}.`,
    userSummary: `Reusable tool for ${name}.`,
    verificationStatus,
    riskLevel: "low",
    tags: ["planner", "tests"],
    invocationHints: [`Ask me to run skill ${name}.`],
    lifecycleStatus: "active",
    updatedAt: "2026-03-10T12:00:00.000Z",
    ...overrides
  };
}

test("workflow bridge prefers a verified active linked skill", () => {
  const bridge = buildWorkflowSkillBridgeSummary({
    workflowHints: [
      buildWorkflowPattern("read_file+run_skill:planner_triage", {
        linkedSkillName: "triage_planner_failure",
        linkedSkillVerificationStatus: "verified"
      }),
      buildWorkflowPattern("respond+read_file:release_summary", {
        confidence: 0.55,
        successCount: 2,
        executionStyle: "multi_action",
        actionSequenceShape: "read_file>respond",
        recoveryPath: null
      })
    ],
    availableSkills: [
      buildSkillEntry("triage_planner_failure", "verified"),
      buildSkillEntry("draft_release_summary", "unverified")
    ]
  });

  assert.ok(bridge);
  assert.equal(bridge?.preferredSkill?.name, "triage_planner_failure");
  assert.equal(bridge?.preferredWorkflowKey, "read_file+run_skill:planner_triage");
  assert.match(bridge?.preferredReason ?? "", /verified skill matched a repeated active workflow/i);
});

test("workflow bridge suggests a new skill when repeated success has no linked skill yet", () => {
  const bridge = buildWorkflowSkillBridgeSummary({
    workflowHints: [
      buildWorkflowPattern("read_file+write_file:normalize_planner_errors", {
        executionStyle: "multi_action",
        actionSequenceShape: "read_file>write_file>respond",
        linkedSkillName: null,
        linkedSkillVerificationStatus: null,
        confidence: 0.74,
        successCount: 4,
        failureCount: 0,
        suppressedCount: 0,
        recoveryPath: null
      })
    ],
    availableSkills: []
  });

  assert.ok(bridge);
  assert.equal(bridge?.preferredSkill, null);
  assert.equal(bridge?.skillSuggestions.length, 1);
  assert.equal(bridge?.skillSuggestions[0]?.suggestedSkillName, "workflow_normalize_planner_errors");
  assert.match(bridge?.skillSuggestions[0]?.reason ?? "", /Repeated active workflow/i);
});

test("workflow bridge surfaces degraded workflow keys as discouraged reuse motifs", () => {
  const bridge = buildWorkflowSkillBridgeSummary({
    workflowHints: [
      buildWorkflowPattern("read_file+run_skill:planner_triage", {
        linkedSkillName: "triage_planner_failure",
        linkedSkillVerificationStatus: "verified",
        successCount: 1,
        failureCount: 3,
        suppressedCount: 1,
        confidence: 0.38
      }),
      buildWorkflowPattern("respond+verify_browser:ui_check", {
        executionStyle: "live_run",
        actionSequenceShape: "probe_http>verify_browser>respond",
        linkedSkillName: null,
        linkedSkillVerificationStatus: null,
        successCount: 1,
        failureCount: 2,
        suppressedCount: 2,
        confidence: 0.29,
        recoveryPath: "browser_verification_recovery"
      })
    ],
    availableSkills: [buildSkillEntry("triage_planner_failure", "verified")]
  });

  assert.ok(bridge);
  assert.deepEqual(bridge?.discouragedWorkflowKeys, [
    "read_file+run_skill:planner_triage",
    "respond+verify_browser:ui_check"
  ]);
});
