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
import type { TaskPrincipalAccessEnvelope, TaskRunResult } from "../../src/core/types";

/**
 * Creates a deterministic task-run fixture for workflow-learning tests.
 */
function buildPrincipalAccess(input: {
  role: string;
  providerUserIdHash: string;
  accessClass: string;
}): TaskPrincipalAccessEnvelope {
  return {
    principalContext: {
      requestId: `request_workflow_${input.role}_${input.providerUserIdHash}`,
      actor: {
        principalRole: input.role,
        identityAuthority: "configured_owner_provider_user_id",
        legacyIdentityState: "principal_verified",
        ownerMatchSource: input.role === "owner" ? "provider_user_id" : "none",
        providerUserIdHash: input.providerUserIdHash
      },
      route: {
        visibility: "private"
      },
      subject: {}
    },
    accessDecision: {
      decisionId: `decision_workflow_${input.role}_${input.providerUserIdHash}`,
      requestId: `request_workflow_${input.role}_${input.providerUserIdHash}`,
      operation: "task_execution",
      accessClass: input.accessClass,
      allowed: true,
      reason: "synthetic_workflow_principal"
    }
  };
}

function buildRunResult(
  userInput: string,
  principalAccess?: TaskPrincipalAccessEnvelope
): TaskRunResult {
  return {
    task: {
      id: "task_workflow_learning_fixture",
      goal: "Summarize deterministic workflow behavior.",
      userInput,
      createdAt: "2026-03-03T00:00:00.000Z",
      principalAccess
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

test("deriveWorkflowObservationFromTaskRun scopes private workflow keys by principal access", () => {
  const ownerAccess = buildPrincipalAccess({
    role: "owner",
    providerUserIdHash: "hash_workflow_owner",
    accessClass: "owner_private"
  });
  const observation = deriveWorkflowObservationFromTaskRun(buildRunResult(
    [
      "You are in an ongoing conversation with the same user.",
      "Current user request:",
      "Please summarize private launch workflow."
    ].join("\n"),
    ownerAccess
  ));

  assert.equal(observation.accessMetadata?.classification, "owner_private");
  assert.match(observation.workflowKey, /scope:owner_private:owner:hash_workflow_owner/i);
});

test("workflow store gates private workflow patterns by retrieval principal", async () => {
  await withWorkflowLearningStore(async ({ filePath }) => {
    const store = new WorkflowLearningStore(filePath);
    const ownerAccess = buildPrincipalAccess({
      role: "owner",
      providerUserIdHash: "hash_workflow_owner",
      accessClass: "owner_private"
    });
    const otherAccess = buildPrincipalAccess({
      role: "allowed_user",
      providerUserIdHash: "hash_workflow_other",
      accessClass: "session_only"
    });
    await store.recordObservation(deriveWorkflowObservationFromTaskRun(buildRunResult(
      [
        "You are in an ongoing conversation with the same user.",
        "Current user request:",
        "Please summarize private launch workflow."
      ].join("\n"),
      ownerAccess
    )));

    const noPrincipalHints = await store.getRelevantPatterns("launch workflow", 3);
    const otherHints = await store.getRelevantPatterns("launch workflow", 3, null, {
      principalAccess: otherAccess
    });
    const ownerHints = await store.getRelevantPatterns("launch workflow", 3, null, {
      principalAccess: ownerAccess
    });

    assert.equal(noPrincipalHints.length, 0);
    assert.equal(otherHints.length, 0);
    assert.equal(ownerHints.length, 1);
  });
});

test("workflow store biases relevant patterns toward the active session lane", async () => {
  await withWorkflowLearningStore(async ({ filePath }) => {
    const store = new WorkflowLearningStore(filePath);
    await store.recordObservation({
      workflowKey: "status_update:project_summary",
      outcome: "success",
      observedAt: "2026-03-03T00:00:00.000Z",
      domainLane: "workflow",
      contextTags: ["status", "summary"]
    });
    await store.recordObservation({
      workflowKey: "status_update:personal_checkin",
      outcome: "success",
      observedAt: "2026-03-03T00:01:00.000Z",
      domainLane: "profile",
      contextTags: ["status", "summary"]
    });

    const workflowHints = await store.getRelevantPatterns("status summary", 2, "workflow");
    const profileHints = await store.getRelevantPatterns("status summary", 2, "profile");

    assert.equal(workflowHints[0]?.domainLane, "workflow");
    assert.equal(profileHints[0]?.domainLane, "profile");
  });
});
