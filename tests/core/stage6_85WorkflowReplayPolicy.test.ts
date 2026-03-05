/**
 * @fileoverview Tests deterministic Stage 6.85 workflow replay policy for capture normalization, script compilation, bridge validation, conflict detection, and receipt mapping.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildWorkflowCaptureV1,
  buildWorkflowRunReceipt,
  compileWorkflowScriptV1,
  detectWorkflowConflict,
  evaluateComputerUseBridge
} from "../../src/core/stage6_85WorkflowReplayPolicy";

/**
 * Implements `buildsSortedWorkflowCaptureAndDeterministicScript` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildsSortedWorkflowCaptureAndDeterministicScript(): void {
  const capture = buildWorkflowCaptureV1({
    captureId: "capture_685_f_001",
    startedAt: "2026-02-27T00:00:00.000Z",
    stoppedAt: "2026-02-27T00:00:05.000Z",
    events: [
      {
        eventId: "evt_2",
        type: "click",
        timestampMs: 2000,
        appWindow: "browser",
        selector: "#submit"
      },
      {
        eventId: "evt_1",
        type: "navigate",
        timestampMs: 1000,
        appWindow: "browser",
        selector: "https://example.com"
      }
    ]
  });
  assert.equal(capture.events[0]?.eventId, "evt_1");

  const script = compileWorkflowScriptV1(capture);
  assert.equal(script.scriptId, "script_capture_685_f_001");
  assert.equal(script.steps.length, 2);
  assert.equal(script.steps[0]?.stepId, "step_01");
  assert.ok((script.steps[0]?.idempotencyKey ?? "").length > 32);
}

/**
 * Implements `validatesComputerUseActionFamilyBridgeFailClosed` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function validatesComputerUseActionFamilyBridgeFailClosed(): void {
  const allowed = evaluateComputerUseBridge({
    actionType: "run_skill",
    actionFamily: "computer_use",
    operation: "compile"
  });
  assert.equal(allowed.allowed, true);

  const blockedActionType = evaluateComputerUseBridge({
    actionType: "write_file",
    actionFamily: "computer_use",
    operation: "compile"
  });
  assert.equal(blockedActionType.allowed, false);

  const blockedFamily = evaluateComputerUseBridge({
    actionType: "run_skill",
    actionFamily: "shell",
    operation: "compile"
  });
  assert.equal(blockedFamily.allowed, false);
}

/**
 * Implements `detectsTypedWorkflowConflictsInDeterministicPriorityOrder` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function detectsTypedWorkflowConflictsInDeterministicPriorityOrder(): void {
  const schemaConflict = detectWorkflowConflict({
    schemaSupported: false,
    windowFocused: true,
    navigationMatches: true,
    selectorFound: true,
    assertionPassed: true
  });
  assert.equal(schemaConflict, "CAPTURE_SCHEMA_UNSUPPORTED");

  const selectorConflict = detectWorkflowConflict({
    schemaSupported: true,
    windowFocused: true,
    navigationMatches: true,
    selectorFound: false,
    assertionPassed: true
  });
  assert.equal(selectorConflict, "SELECTOR_NOT_FOUND");
}

/**
 * Implements `mapsConflictCodesToWorkflowDriftRunReceipts` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function mapsConflictCodesToWorkflowDriftRunReceipts(): void {
  const blockedReceipt = buildWorkflowRunReceipt({
    runId: "run_685_f_001",
    scriptId: "script_capture_685_f_001",
    operation: "replay_step",
    conflictCode: "SELECTOR_NOT_FOUND"
  });
  assert.equal(blockedReceipt.approved, false);
  assert.equal(blockedReceipt.blockCode, "WORKFLOW_DRIFT_DETECTED");

  const approvedReceipt = buildWorkflowRunReceipt({
    runId: "run_685_f_002",
    scriptId: "script_capture_685_f_001",
    operation: "replay_step",
    conflictCode: null
  });
  assert.equal(approvedReceipt.approved, true);
  assert.equal(approvedReceipt.blockCode, null);
}

test(
  "stage 6.85 workflow replay policy sorts capture events and compiles deterministic scripts",
  buildsSortedWorkflowCaptureAndDeterministicScript
);
test(
  "stage 6.85 workflow replay policy validates actionFamily computer_use bridge fail-closed",
  validatesComputerUseActionFamilyBridgeFailClosed
);
test(
  "stage 6.85 workflow replay policy emits typed conflict codes in deterministic priority order",
  detectsTypedWorkflowConflictsInDeterministicPriorityOrder
);
test(
  "stage 6.85 workflow replay policy maps typed conflicts to workflow drift run receipts",
  mapsConflictCodesToWorkflowDriftRunReceipts
);
