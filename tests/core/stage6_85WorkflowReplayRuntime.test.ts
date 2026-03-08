/**
 * @fileoverview Tests canonical Stage 6.85 workflow-replay runtime helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildWorkflowCaptureV1,
  buildWorkflowRunReceipt,
  compileWorkflowScriptV1,
  detectWorkflowConflict,
  evaluateComputerUseBridge
} from "../../src/core/stage6_85/workflowReplay";

test("stage6_85 workflow-replay runtime preserves deterministic capture and script shaping", () => {
  const capture = buildWorkflowCaptureV1({
    captureId: "capture_685_runtime",
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
  assert.equal(script.scriptId, "script_capture_685_runtime");
  assert.equal(script.steps[0]?.stepId, "step_01");
});

test("stage6_85 workflow-replay runtime preserves deterministic bridge and conflict rules", () => {
  const allowed = evaluateComputerUseBridge({
    actionType: "run_skill",
    actionFamily: "computer_use",
    operation: "compile"
  });
  assert.equal(allowed.allowed, true);

  const blocked = evaluateComputerUseBridge({
    actionType: "write_file",
    actionFamily: "computer_use",
    operation: "compile"
  });
  assert.equal(blocked.allowed, false);

  const conflict = detectWorkflowConflict({
    schemaSupported: true,
    windowFocused: true,
    navigationMatches: true,
    selectorFound: false,
    assertionPassed: true
  });
  assert.equal(conflict, "SELECTOR_NOT_FOUND");
});

test("stage6_85 workflow-replay runtime preserves deterministic receipt shaping", () => {
  const receipt = buildWorkflowRunReceipt({
    runId: "run_685_runtime",
    scriptId: "script_capture_685_runtime",
    operation: "replay_step",
    conflictCode: "SELECTOR_NOT_FOUND"
  });
  assert.equal(receipt.approved, false);
  assert.equal(receipt.blockCode, "WORKFLOW_DRIFT_DETECTED");
});
