/**
 * @fileoverview Tests extracted autonomy contract, evidence, completion-gate, and stop-reason modules.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EXECUTION_STYLE_LIVE_VERIFICATION_BLOCKED_REASON_CODE,
  MISSION_REQUIREMENT_BROWSER,
  MISSION_REQUIREMENT_PROCESS_STOP,
  MISSION_REQUIREMENT_READINESS,
  MISSION_REQUIREMENT_SIDE_EFFECT,
  formatReasonWithCode,
  type MissionCompletionContract
} from "../../src/core/autonomy/contracts";
import { buildMissionCompletionContract } from "../../src/core/autonomy/missionContract";
import {
  buildManagedProcessStopRetryInput,
  buildMissionEvidenceRetryInput,
  countApprovedReadinessProofActions,
  mapRequirementToReasonCode,
  resolveMissingMissionRequirements
} from "../../src/core/autonomy/missionEvidence";
import {
  formatManagedProcessNeverReadyReason,
  resolveLiveVerificationBlockedAbortReason
} from "../../src/core/autonomy/completionGate";
import { humanizeAutonomousStopReason } from "../../src/core/autonomy/stopReasonText";
import { type ActionRunResult, type TaskRunResult } from "../../src/core/types";

/**
 * Builds a minimal task result for autonomy-module tests.
 *
 * @param actionResults - Action results to include.
 * @returns Task result wrapper containing the supplied action results.
 */
function buildTaskResult(actionResults: ActionRunResult[]): TaskRunResult {
  return {
    task: {
      id: "task_autonomy_modules",
      goal: "test",
      userInput: "test",
      createdAt: new Date().toISOString()
    },
    plan: {
      taskId: "task_autonomy_modules",
      plannerNotes: "stub",
      actions: actionResults.map((entry) => entry.action)
    },
    actionResults,
    summary: "stub summary",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  };
}

/**
 * Builds an approved port-readiness probe result for autonomy-module tests.
 *
 * @param actionId - Action id to assign.
 * @returns Approved port-readiness action result.
 */
function buildApprovedProbePortReadyResult(actionId: string): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "probe_port",
      description: "probe localhost readiness",
      params: {
        host: "127.0.0.1",
        port: 3000
      },
      estimatedCostUsd: 0.03
    },
    mode: "escalation_path",
    approved: true,
    output: "Port ready: 127.0.0.1:3000 accepted a TCP connection.",
    executionStatus: "success",
    executionMetadata: {
      readinessProbe: true,
      probeKind: "port",
      probeReady: true,
      processLifecycleStatus: "PROCESS_READY",
      probeHost: "127.0.0.1",
      probePort: 3000
    },
    blockedBy: [],
    violations: [],
    votes: []
  };
}

/**
 * Builds an approved managed-process start result for autonomy-module tests.
 *
 * @param actionId - Action id to assign.
 * @returns Approved start-process action result.
 */
function buildApprovedStartProcessResult(actionId: string): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "start_process",
      description: "start localhost server",
      params: {
        command: "python -m http.server 3000",
        cwd: "runtime/generated"
      },
      estimatedCostUsd: 0.28
    },
    mode: "escalation_path",
    approved: true,
    output: "Process started: lease proc_autonomy_modules_1 (pid 4242).",
    executionStatus: "success",
    executionMetadata: {
      managedProcess: true,
      processLeaseId: "proc_autonomy_modules_1",
      processLifecycleStatus: "PROCESS_STARTED",
      processPid: 4242
    },
    blockedBy: [],
    violations: [],
    votes: []
  };
}

/**
 * Builds a blocked HTTP-readiness probe result for autonomy-module tests.
 *
 * @param actionId - Action id to assign.
 * @returns Blocked HTTP readiness action result.
 */
function buildBlockedProbeHttpGovernanceResult(actionId: string): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "probe_http",
      description: "probe localhost readiness",
      params: {
        url: "http://127.0.0.1:3000/"
      },
      estimatedCostUsd: 0.03
    },
    mode: "escalation_path",
    approved: false,
    output: "Probe blocked by governor policy.",
    executionStatus: "blocked",
    blockedBy: ["resource", "continuity", "utility"],
    violations: [],
    votes: []
  };
}

test("buildMissionCompletionContract captures finite live-run mission requirements", () => {
  const contract = buildMissionCompletionContract(
    "Create a tiny local site in C:\\demo, run it on localhost, verify the homepage UI in a real browser, keep the flow finite, and then stop the process. Execute now."
  );

  assert.equal(contract.executionStyle, true);
  assert.equal(contract.requireRealSideEffect, true);
  assert.equal(contract.requireTargetPathTouch, true);
  assert.equal(contract.requireReadinessProof, true);
  assert.equal(contract.requireBrowserProof, true);
  assert.equal(contract.requireProcessStopProof, true);
  assert.deepEqual(contract.targetPathHints, ["c:\\demo"]);
});

test("buildMissionCompletionContract treats Playwright verification language as browser proof", () => {
  const contract = buildMissionCompletionContract(
    "Build a tiny static site on /tmp/demo, start it locally, verify it in Playwright, and then stop the server. Execute now."
  );

  assert.equal(contract.executionStyle, true);
  assert.equal(contract.requireReadinessProof, true);
  assert.equal(contract.requireBrowserProof, true);
  assert.equal(contract.requireProcessStopProof, true);
});

test("countApprovedReadinessProofActions treats port-only proof as insufficient for browser goals", () => {
  const result = buildTaskResult([buildApprovedProbePortReadyResult("probe_port_ready_1")]);

  assert.equal(countApprovedReadinessProofActions(result), 1);
  assert.equal(countApprovedReadinessProofActions(result, true), 0);
});

test("mission evidence helpers resolve missing requirements and build deterministic retry guidance", () => {
  const contract: MissionCompletionContract = {
    executionStyle: true,
    requireRealSideEffect: true,
    requireTargetPathTouch: false,
    requireArtifactMutation: false,
    requireReadinessProof: true,
    requireBrowserProof: true,
    requireProcessStopProof: true,
    targetPathHints: []
  };

  const missing = resolveMissingMissionRequirements(contract, {
    realSideEffects: 0,
    targetPathTouches: 0,
    artifactMutations: 0,
    readinessProofs: 0,
    browserProofs: 0,
    processStopProofs: 0
  });

  assert.deepEqual(missing, [
    MISSION_REQUIREMENT_SIDE_EFFECT,
    MISSION_REQUIREMENT_READINESS,
    MISSION_REQUIREMENT_BROWSER,
    MISSION_REQUIREMENT_PROCESS_STOP
  ]);
  assert.equal(
    mapRequirementToReasonCode(MISSION_REQUIREMENT_PROCESS_STOP),
    "AUTONOMOUS_EXECUTION_STYLE_PROCESS_STOP_EVIDENCE_REQUIRED"
  );
  assert.match(
    buildMissionEvidenceRetryInput(
      "Run the local app and verify the page.",
      missing,
      [],
      true
    ),
    /prove actual localhost HTTP\/browser readiness/i
  );
  assert.match(buildManagedProcessStopRetryInput("proc_demo"), /^stop_process leaseId="proc_demo"/i);
});

test("resolveLiveVerificationBlockedAbortReason returns a typed abort reason for blocked live proof", () => {
  const result = buildTaskResult([buildBlockedProbeHttpGovernanceResult("probe_http_blocked_1")]);
  const contract: MissionCompletionContract = {
    executionStyle: true,
    requireRealSideEffect: true,
    requireTargetPathTouch: false,
    requireArtifactMutation: false,
    requireReadinessProof: true,
    requireBrowserProof: true,
    requireProcessStopProof: false,
    targetPathHints: []
  };

  const reason = resolveLiveVerificationBlockedAbortReason(
    result,
    contract,
    [MISSION_REQUIREMENT_READINESS, MISSION_REQUIREMENT_BROWSER]
  );

  assert.ok(reason);
  assert.match(reason ?? "", new RegExp(EXECUTION_STYLE_LIVE_VERIFICATION_BLOCKED_REASON_CODE, "i"));
  assert.match(reason ?? "", /localhost readiness and browser verification steps/i);
});

test("resolveLiveVerificationBlockedAbortReason ignores mixed iterations that made live-run progress", () => {
  const result = buildTaskResult([
    buildApprovedStartProcessResult("start_process_live_progress_1"),
    buildBlockedProbeHttpGovernanceResult("probe_http_blocked_after_start_1")
  ]);
  const contract: MissionCompletionContract = {
    executionStyle: true,
    requireRealSideEffect: true,
    requireTargetPathTouch: false,
    requireArtifactMutation: false,
    requireReadinessProof: true,
    requireBrowserProof: true,
    requireProcessStopProof: false,
    targetPathHints: []
  };

  const reason = resolveLiveVerificationBlockedAbortReason(
    result,
    contract,
    [MISSION_REQUIREMENT_READINESS, MISSION_REQUIREMENT_BROWSER]
  );

  assert.equal(reason, null);
});

test("formatManagedProcessNeverReadyReason keeps the target label and shared reason-code prefix", () => {
  const reason = formatManagedProcessNeverReadyReason("http://localhost:8125");

  assert.equal(
    reason,
    formatReasonWithCode(
      "AUTONOMOUS_EXECUTION_STYLE_PROCESS_NEVER_READY",
      "Live verification stopped because the running local process never became HTTP-ready at http://localhost:8125, so I stopped retrying and could not truthfully confirm the app or page in this run."
    )
  );
});

test("humanizeAutonomousStopReason still reads from the canonical stop-reason module", () => {
  const rendered = humanizeAutonomousStopReason(
    "[reasonCode=AUTONOMOUS_TASK_EXECUTION_FAILED] Iteration 1 failed before completion: Planner model returned no live-verification actions for execution-style live-run request."
  );

  assert.match(rendered, /planner never produced a valid live-run verification plan/i);
  assert.match(rendered, /next step: retry with an explicit request to start the app/i);
});
