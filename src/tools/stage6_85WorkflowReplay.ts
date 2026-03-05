/**
 * @fileoverview Runs Stage 6.85 checkpoint 6.85.F workflow replay checks and emits deterministic evidence artifacts.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildWorkflowCaptureV1,
  buildWorkflowRunReceipt,
  compileWorkflowScriptV1,
  detectWorkflowConflict,
  evaluateComputerUseBridge
} from "../core/stage6_85WorkflowReplayPolicy";

const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_85_workflow_replay_report.json"
);

interface Stage685CheckpointFArtifact {
  generatedAt: string;
  command: string;
  checkpointId: "6.85.F";
  capture: {
    captureId: string;
    eventCount: number;
    sortedFirstEventId: string | null;
  };
  script: {
    scriptId: string;
    stepCount: number;
    firstStepOperation: string | null;
  };
  bridge: {
    valid: boolean;
    invalidFamilyBlocked: boolean;
    invalidActionTypeBlocked: boolean;
  };
  drift: {
    conflictCode: string | null;
    runReceiptBlockCode: string | null;
  };
  passCriteria: {
    captureCompilePass: boolean;
    bridgePolicyPass: boolean;
    typedDriftPass: boolean;
    governanceParityPass: boolean;
    overallPass: boolean;
  };
}

/**
 * Executes stage685 checkpoint f as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the stage685 checkpoint f runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses `buildWorkflowCaptureV1` (import `buildWorkflowCaptureV1`) from `../core/stage6_85WorkflowReplayPolicy`.
 * - Uses `buildWorkflowRunReceipt` (import `buildWorkflowRunReceipt`) from `../core/stage6_85WorkflowReplayPolicy`.
 * - Uses `compileWorkflowScriptV1` (import `compileWorkflowScriptV1`) from `../core/stage6_85WorkflowReplayPolicy`.
 * - Uses `detectWorkflowConflict` (import `detectWorkflowConflict`) from `../core/stage6_85WorkflowReplayPolicy`.
 * - Uses `evaluateComputerUseBridge` (import `evaluateComputerUseBridge`) from `../core/stage6_85WorkflowReplayPolicy`.
 * @returns Promise resolving to Stage685CheckpointFArtifact.
 */
export async function runStage685CheckpointF(): Promise<Stage685CheckpointFArtifact> {
  const capture = buildWorkflowCaptureV1({
    captureId: "capture_685_f_001",
    startedAt: "2026-02-27T00:00:00.000Z",
    stoppedAt: "2026-02-27T00:00:06.000Z",
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
      },
      {
        eventId: "evt_3",
        type: "type",
        timestampMs: 3000,
        appWindow: "browser",
        selector: "#search-box",
        value: "deterministic replay"
      }
    ]
  });
  const script = compileWorkflowScriptV1(capture);

  const bridgeValid = evaluateComputerUseBridge({
    actionType: "run_skill",
    actionFamily: "computer_use",
    operation: "replay_step"
  });
  const bridgeInvalidFamily = evaluateComputerUseBridge({
    actionType: "run_skill",
    actionFamily: "shell",
    operation: "replay_step"
  });
  const bridgeInvalidActionType = evaluateComputerUseBridge({
    actionType: "write_file",
    actionFamily: "computer_use",
    operation: "replay_step"
  });

  const conflictCode = detectWorkflowConflict({
    schemaSupported: true,
    windowFocused: true,
    navigationMatches: true,
    selectorFound: false,
    assertionPassed: true
  });
  const runReceipt = buildWorkflowRunReceipt({
    runId: "run_685_f_001",
    scriptId: script.scriptId,
    operation: "replay_step",
    conflictCode
  });

  const captureCompilePass =
    capture.events.length === 3 &&
    capture.events[0]?.eventId === "evt_1" &&
    script.steps.length === 3;
  const bridgePolicyPass =
    bridgeValid.allowed &&
    bridgeInvalidFamily.allowed === false &&
    bridgeInvalidActionType.allowed === false;
  const typedDriftPass =
    conflictCode === "SELECTOR_NOT_FOUND" &&
    runReceipt.blockCode === "WORKFLOW_DRIFT_DETECTED" &&
    runReceipt.conflictCode === "SELECTOR_NOT_FOUND";
  const governanceParityPass = runReceipt.actionTypeBridge === "run_skill" && runReceipt.actionFamily === "computer_use";
  const overallPass = captureCompilePass && bridgePolicyPass && typedDriftPass && governanceParityPass;

  return {
    generatedAt: new Date().toISOString(),
    command: "npm run test:stage6_85:workflow_replay",
    checkpointId: "6.85.F",
    capture: {
      captureId: capture.captureId,
      eventCount: capture.events.length,
      sortedFirstEventId: capture.events[0]?.eventId ?? null
    },
    script: {
      scriptId: script.scriptId,
      stepCount: script.steps.length,
      firstStepOperation: script.steps[0]?.operation ?? null
    },
    bridge: {
      valid: bridgeValid.allowed,
      invalidFamilyBlocked: !bridgeInvalidFamily.allowed,
      invalidActionTypeBlocked: !bridgeInvalidActionType.allowed
    },
    drift: {
      conflictCode,
      runReceiptBlockCode: runReceipt.blockCode
    },
    passCriteria: {
      captureCompilePass,
      bridgePolicyPass,
      typedDriftPass,
      governanceParityPass,
      overallPass
    }
  };
}

/**
 * Runs the `stage6_85WorkflowReplay` entrypoint workflow.
 *
 * **Why it exists:**
 * Coordinates imported collaborators behind the `main` function boundary.
 *
 * **What it talks to:**
 * - Uses `mkdir` (import `mkdir`) from `node:fs/promises`.
 * - Uses `writeFile` (import `writeFile`) from `node:fs/promises`.
 * - Uses `path` (import `default`) from `node:path`.
 * @returns Promise resolving to void.
 */
async function main(): Promise<void> {
  const artifact = await runStage685CheckpointF();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log(`Stage 6.85 checkpoint 6.85.F artifact: ${ARTIFACT_PATH}`);
  console.log(`Pass status: ${artifact.passCriteria.overallPass ? "PASS" : "FAIL"}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
