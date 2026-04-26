/**
 * @fileoverview Tests extracted autonomy contract, evidence, completion-gate, and stop-reason modules.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildAutonomousRecoverySnapshot,
  EXECUTION_STYLE_STALL_REASON_CODE,
  EXECUTION_STYLE_LIVE_VERIFICATION_BLOCKED_REASON_CODE,
  MISSION_REQUIREMENT_BROWSER,
  MISSION_REQUIREMENT_BROWSER_OPEN,
  MISSION_REQUIREMENT_PROCESS_STOP,
  MISSION_REQUIREMENT_READINESS,
  MISSION_REQUIREMENT_SIDE_EFFECT,
  formatReasonWithCode,
  type MissionCompletionContract
} from "../../src/core/autonomy/contracts";
import { evaluateAutonomousNextStep } from "../../src/core/autonomy/agentLoopModelPolicy";
import { hasMissionStopLimitReached } from "../../src/core/autonomy/agentLoopRuntimeSupport";
import { buildMissionCompletionContract } from "../../src/core/autonomy/missionContract";
import {
  buildManagedProcessStopRetryInput,
  buildMissionEvidenceRetryInput,
  countApprovedBrowserOpenProofActions,
  countApprovedReadinessProofActions,
  mapRequirementToReasonCode,
  resolveMissingMissionRequirements
} from "../../src/core/autonomy/missionEvidence";
import {
  formatManagedProcessNeverReadyReason,
  resolveLiveVerificationBlockedAbortReason
} from "../../src/core/autonomy/completionGate";
import {
  buildRetryingStateMessage,
  buildStructuredRecoveryStateMessage,
  buildVerificationStateMessage,
  buildWorkingStateMessage,
  buildWorkspaceRecoveryStateMessage
} from "../../src/core/autonomy/agentLoopProgress";
import { DEFAULT_BRAIN_CONFIG } from "../../src/core/config";
import { humanizeAutonomousStopReason } from "../../src/core/autonomy/stopReasonText";
import {
  buildRecoveryAttemptFingerprint,
  buildStructuredRecoveryExecutionPlan,
  evaluateStructuredRecoveryPolicy
} from "../../src/core/stage6_85/recovery";
import { resolveStructuredRecoveryRuntimeDecision } from "../../src/core/autonomy/structuredRecoveryRuntime";
import { type ActionRunResult, type TaskRunResult } from "../../src/core/types";
import { buildWorkspaceRecoverySignalFixture } from "../helpers/conversationFixtures";

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
 * Builds an approved localhost browser-open result that already proved readiness for autonomy tests.
 *
 * @param actionId - Action id to assign.
 * @returns Approved browser-open action result with localhost readiness metadata.
 */
function buildApprovedOpenBrowserReadyResult(actionId: string): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "open_browser",
      description: "open the running localhost preview in a visible browser",
      params: {
        url: "http://127.0.0.1:3000/"
      },
      estimatedCostUsd: 0.03
    },
    mode: "escalation_path",
    approved: true,
    output: "Opened http://127.0.0.1:3000/ in a visible browser window and left it open for you.",
    executionStatus: "success",
    executionMetadata: {
      browserSession: true,
      browserSessionId: "browser_session:action_open_browser_ready_1",
      browserSessionUrl: "http://127.0.0.1:3000/",
      browserSessionStatus: "open",
      browserSessionVisibility: "visible",
      browserSessionControlAvailable: true,
      processLifecycleStatus: "PROCESS_READY"
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

/**
 * Builds an approved workspace-resource inspection result for autonomy-module tests.
 *
 * @param actionId - Action id to assign.
 * @param executionMetadata - Structured inspection metadata to attach.
 * @returns Approved inspection action result.
 */
function buildApprovedInspectWorkspaceResourcesResult(
  actionId: string,
  executionMetadata: Record<string, unknown>
): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "inspect_workspace_resources",
      description: "inspect tracked workspace resources",
      params: {
        rootPath: "C:\\Users\\testuser\\Desktop\\Detroit City Two",
        previewUrl: "http://127.0.0.1:3000/",
        browserSessionId: "browser_session:detroit_two",
        previewProcessLeaseId: "proc_detroit_two"
      },
      estimatedCostUsd: 0.04
    },
    mode: "fast_path",
    approved: true,
    output: "Inspection complete.",
    executionStatus: "success",
    executionMetadata: {
      runtimeOwnershipInspection: true,
      runtimeOwnershipInspectionKind: "workspace_resources",
      inspectionRootPath: "C:\\Users\\testuser\\Desktop\\Detroit City Two",
      inspectionPreviewUrl: "http://127.0.0.1:3000/",
      ...executionMetadata
    },
    blockedBy: [],
    violations: [],
    votes: []
  };
}

/**
 * Builds an approved HTTP-readiness probe result for autonomy-module tests.
 *
 * @param actionId - Action id to assign.
 * @param url - Loopback URL proven ready by the probe.
 * @returns Approved HTTP-readiness action result.
 */
function buildApprovedProbeHttpReadyResult(
  actionId: string,
  url: string
): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "probe_http",
      description: "probe localhost http readiness",
      params: {
        url,
        expectedStatus: 200
      },
      estimatedCostUsd: 0.03
    },
    mode: "escalation_path",
    approved: true,
    output: `HTTP ready: ${url} returned status 200.`,
    executionStatus: "success",
    executionMetadata: {
      readinessProbe: true,
      probeKind: "http",
      probeReady: true,
      probeUrl: url,
      processLifecycleStatus: "PROCESS_READY"
    },
    blockedBy: [],
    violations: [],
    votes: []
  };
}

/**
 * Builds a blocked shell action result for executor-missing tests.
 *
 * @param actionId - Action id to assign.
 * @returns Blocked shell action result with missing-executable metadata.
 */
function buildBlockedShellExecutableMissingResult(actionId: string): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "shell_command",
      description: "run a shell command",
      params: {
        command: "python app.py"
      },
      estimatedCostUsd: 0.03
    },
    mode: "escalation_path",
    approved: false,
    output: "Shell failed: executable not found.",
    executionStatus: "blocked",
    executionFailureCode: "SHELL_EXECUTABLE_NOT_FOUND",
    blockedBy: ["SHELL_EXECUTABLE_NOT_FOUND"],
    violations: [
      {
        code: "SHELL_EXECUTABLE_NOT_FOUND",
        message: "Shell executable missing."
      }
    ],
    votes: []
  };
}

/**
 * Builds a blocked shell action result carrying a deterministically identifiable missing dependency.
 *
 * @param actionId - Action id to assign.
 * @returns Blocked shell action result with native recovery metadata.
 */
function buildBlockedMissingDependencyShellResult(actionId: string): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "shell_command",
      description: "build the current app",
      params: {
        command: "npm run build",
        cwd: "C:\\Users\\testuser\\OneDrive\\Desktop\\Calm Sample"
      },
      estimatedCostUsd: 0.08
    },
    mode: "escalation_path",
    approved: false,
    output:
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@vitejs/plugin-react' imported from C:\\Users\\testuser\\OneDrive\\Desktop\\Calm Sample\\vite.config.js",
    executionStatus: "failed",
    executionFailureCode: "ACTION_EXECUTION_FAILED",
    executionMetadata: {
      recoveryFailureClass: "DEPENDENCY_MISSING",
      recoveryFailureProvenance: "executor_mechanical"
    },
    blockedBy: ["ACTION_EXECUTION_FAILED"],
    violations: [
      {
        code: "ACTION_EXECUTION_FAILED",
        message: "Build failed because a dependency is missing."
      }
    ],
    votes: []
  };
}

function buildBlockedStartProcessPortInUseResult(
  actionId: string,
  requestedPort = 3000,
  suggestedPort = 63292
): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "start_process",
      description: "start the local server",
      params: {
        command: `npm run dev -- --hostname 127.0.0.1 --port ${requestedPort}`,
        cwd: "C:\\Users\\testuser\\OneDrive\\Desktop\\Detroit City Two"
      },
      estimatedCostUsd: 0.28
    },
    mode: "escalation_path",
    approved: false,
    output:
      `Process start failed: http://127.0.0.1:${requestedPort} was already occupied before startup. ` +
      `Try a different free loopback port such as ${suggestedPort}.`,
    executionStatus: "failed",
    executionFailureCode: "PROCESS_START_FAILED",
    executionMetadata: {
      processStartupFailureKind: "PORT_IN_USE",
      processRequestedHost: "127.0.0.1",
      processRequestedPort: requestedPort,
      processRequestedUrl: `http://127.0.0.1:${requestedPort}`,
      processSuggestedPort: suggestedPort,
      processSuggestedUrl: `http://127.0.0.1:${suggestedPort}`,
      processCwd: "C:\\Users\\testuser\\OneDrive\\Desktop\\Detroit City Two"
    },
    blockedBy: ["PROCESS_START_FAILED"],
    violations: [],
    votes: []
  };
}

/**
 * Builds a blocked action result carrying the terminal mission-stop block code.
 *
 * @param actionId - Action id to assign.
 * @returns Blocked action result with `MISSION_STOP_LIMIT_REACHED`.
 */
function buildBlockedMissionStopLimitResult(actionId: string): ActionRunResult {
  return {
    action: {
      id: actionId,
      type: "respond",
      description: "report mission stop",
      params: {
        message: "stopped"
      },
      estimatedCostUsd: 0.01
    },
    mode: "fast_path",
    approved: false,
    output: "Mission stop limit reached.",
    executionStatus: "blocked",
    executionFailureCode: "MISSION_STOP_LIMIT_REACHED",
    blockedBy: ["MISSION_STOP_LIMIT_REACHED"],
    violations: [
      {
        code: "MISSION_STOP_LIMIT_REACHED",
        message: "Mission stop budget exhausted."
      }
    ],
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
  assert.equal(contract.requireBrowserOpenProof, false);
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
  assert.equal(contract.requireBrowserOpenProof, false);
  assert.equal(contract.requireProcessStopProof, true);
});

test("buildMissionCompletionContract does not force localhost readiness for a static browser preview request", () => {
  const contract = buildMissionCompletionContract(
    "Build a tech landing page on my desktop, create a folder called sample-company, and leave it open in a browser for me."
  );

  assert.equal(contract.executionStyle, true);
  assert.equal(contract.requireRealSideEffect, true);
  assert.equal(contract.requireReadinessProof, false);
  assert.equal(contract.requireBrowserProof, false);
  assert.equal(contract.requireBrowserOpenProof, false);
  assert.equal(contract.requireProcessStopProof, false);
});

test("buildMissionCompletionContract does not force artifact-mutation proof for scaffold-only workspace bootstrap turns", () => {
  const contract = buildMissionCompletionContract(
    "Handle this first step only: create a new React single page app in a folder on my desktop. Use a real scaffold-capable toolchain step, then install dependencies so package.json and node_modules exist. Stop after the workspace is ready for edits. Do not start a preview server, do not verify localhost, and do not open a browser yet."
  );

  assert.equal(contract.executionStyle, true);
  assert.equal(contract.requireRealSideEffect, true);
  assert.equal(contract.requireArtifactMutation, false);
  assert.equal(contract.requireReadinessProof, false);
  assert.equal(contract.requireBrowserProof, false);
  assert.equal(contract.requireBrowserOpenProof, false);
  assert.equal(contract.requireProcessStopProof, false);
});

test("countApprovedReadinessProofActions treats port-only proof as insufficient for browser goals", () => {
  const result = buildTaskResult([buildApprovedProbePortReadyResult("probe_port_ready_1")]);

  assert.equal(countApprovedReadinessProofActions(result), 1);
  assert.equal(countApprovedReadinessProofActions(result, true), 0);
});

test("countApprovedReadinessProofActions counts localhost open_browser success as readiness proof", () => {
  const result = buildTaskResult([buildApprovedOpenBrowserReadyResult("open_browser_ready_1")]);

  assert.equal(countApprovedReadinessProofActions(result), 1);
  assert.equal(countApprovedReadinessProofActions(result, true), 1);
});

test("countApprovedBrowserOpenProofActions counts visible open_browser success separately", () => {
  const result = buildTaskResult([buildApprovedOpenBrowserReadyResult("open_browser_visible_1")]);

  assert.equal(countApprovedBrowserOpenProofActions(result), 1);
});

test("mission evidence helpers resolve missing requirements and build deterministic retry guidance", () => {
  const contract: MissionCompletionContract = {
    executionStyle: true,
    requireRealSideEffect: true,
    requireTargetPathTouch: false,
    requireArtifactMutation: false,
    requireReadinessProof: true,
    requireBrowserProof: true,
    requireBrowserOpenProof: true,
    requireProcessStopProof: true,
    targetPathHints: []
  };

  const missing = resolveMissingMissionRequirements(contract, {
    realSideEffects: 0,
    targetPathTouches: 0,
    artifactMutations: 0,
    readinessProofs: 0,
    browserProofs: 0,
    browserOpenProofs: 0,
    processStopProofs: 0
  });

  assert.deepEqual(missing, [
    MISSION_REQUIREMENT_SIDE_EFFECT,
    MISSION_REQUIREMENT_READINESS,
    MISSION_REQUIREMENT_BROWSER,
    MISSION_REQUIREMENT_BROWSER_OPEN,
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
    requireBrowserOpenProof: false,
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
    requireBrowserOpenProof: false,
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

test("buildAutonomousRecoverySnapshot derives generic recovery classes and proof gaps", () => {
  const contract: MissionCompletionContract = {
    executionStyle: true,
    requireRealSideEffect: true,
    requireTargetPathTouch: false,
    requireArtifactMutation: false,
    requireReadinessProof: true,
    requireBrowserProof: false,
    requireBrowserOpenProof: false,
    requireProcessStopProof: false,
    targetPathHints: []
  };
  const result = buildTaskResult([
    buildBlockedShellExecutableMissingResult("shell_missing_exec_1")
  ]);
  const missingRequirements = resolveMissingMissionRequirements(contract, {
    realSideEffects: 0,
    targetPathTouches: 0,
    artifactMutations: 0,
    readinessProofs: 0,
    browserProofs: 0,
    browserOpenProofs: 0,
    processStopProofs: 0
  });

  const snapshot = buildAutonomousRecoverySnapshot({
    result,
    missionContract: contract,
    missingRequirements
  });

  assert.equal(snapshot.missionStopLimitReached, false);
  assert.deepEqual(snapshot.proofGaps, [
    "REAL_SIDE_EFFECT_MISSING",
    "READINESS_PROOF_MISSING"
  ]);
  assert.equal(snapshot.failureSignals.length, 1);
  assert.equal(snapshot.failureSignals[0]?.recoveryClass, "EXECUTABLE_NOT_FOUND");
  assert.equal(snapshot.failureSignals[0]?.provenance, "executor_mechanical");
  assert.equal(snapshot.repairOptions[0]?.optionId, "resolve_known_executable");
  assert.equal(snapshot.remainingBudgetHint, "executor_native_only");
});

test("buildAutonomousRecoverySnapshot prefers native recovery metadata over legacy code mapping", () => {
  const contract: MissionCompletionContract = {
    executionStyle: true,
    requireRealSideEffect: true,
    requireTargetPathTouch: false,
    requireArtifactMutation: false,
    requireReadinessProof: false,
    requireBrowserProof: false,
    requireBrowserOpenProof: false,
    requireProcessStopProof: false,
    targetPathHints: []
  };
  const result = buildTaskResult([
    {
      action: {
        id: "shell_native_recovery_1",
        type: "shell_command",
        description: "run npm command",
        params: {
          command: "npm run dev"
        },
        estimatedCostUsd: 0.03
      },
      mode: "escalation_path",
      approved: false,
      output: "Shell failed: spawn ENOENT",
      executionStatus: "failed",
      executionFailureCode: "ACTION_EXECUTION_FAILED",
      executionMetadata: {
        recoveryFailureClass: "EXECUTABLE_NOT_FOUND",
        recoveryFailureProvenance: "executor_mechanical"
      },
      blockedBy: ["ACTION_EXECUTION_FAILED"],
      violations: [
        {
          code: "ACTION_EXECUTION_FAILED",
          message: "Shell failed."
        }
      ],
      votes: []
    }
  ]);
  const missingRequirements = resolveMissingMissionRequirements(contract, {
    realSideEffects: 0,
    targetPathTouches: 0,
    artifactMutations: 0,
    readinessProofs: 0,
    browserProofs: 0,
    browserOpenProofs: 0,
    processStopProofs: 0
  });

  const snapshot = buildAutonomousRecoverySnapshot({
    result,
    missionContract: contract,
    missingRequirements
  });

  assert.deepEqual(snapshot.failureSignals, [
    {
      recoveryClass: "EXECUTABLE_NOT_FOUND",
      provenance: "executor_mechanical",
      sourceCode: "ACTION_EXECUTION_FAILED",
      actionType: "shell_command",
      realm: "shell",
      detail: null
    }
  ]);
});

test("hasMissionStopLimitReached reads typed block codes instead of summary text", () => {
  const result = buildTaskResult([
    buildBlockedMissionStopLimitResult("mission_stop_limit_1")
  ]);
  result.summary = "summary without recovery postmortem marker";

  assert.equal(hasMissionStopLimitReached(result), true);
});

test("evaluateAutonomousNextStep passes structured recovery snapshot to the model", async () => {
  const prompts: Array<Record<string, unknown>> = [];
  const result = buildTaskResult([
    buildBlockedShellExecutableMissingResult("shell_missing_exec_prompt_1")
  ]);
  const modelClient = {
    completeJson: async (request: { userPrompt: string }) => {
      prompts.push(JSON.parse(request.userPrompt) as Record<string, unknown>);
      return {
        isGoalMet: false,
        reasoning: "need deterministic repair",
        nextUserInput: "retry with known executable"
      };
    }
  } as unknown as {
    completeJson: (request: { userPrompt: string }) => Promise<{
      isGoalMet: boolean;
      reasoning: string;
      nextUserInput: string;
    }>;
  };

  await evaluateAutonomousNextStep(
    modelClient as never,
    DEFAULT_BRAIN_CONFIG,
    "Write a file in the workspace.",
    result,
    {
      realSideEffects: 0,
      targetPathTouches: 0,
      artifactMutations: 0,
      readinessProofs: 0,
      browserProofs: 0,
      browserOpenProofs: 0,
      processStopProofs: 0
    },
    null,
    null,
    null
  );

  const recoverySnapshot = prompts[0]?.recoverySnapshot as Record<string, unknown> | undefined;
  assert.ok(recoverySnapshot);
  assert.equal(recoverySnapshot?.remainingBudgetHint, "executor_native_only");
  const failureSignals = recoverySnapshot?.failureSignals as Array<Record<string, unknown>>;
  assert.equal(failureSignals[0]?.recoveryClass, "EXECUTABLE_NOT_FOUND");
  const repairOptions = recoverySnapshot?.repairOptions as Array<Record<string, unknown>>;
  assert.equal(repairOptions[0]?.optionId, "resolve_known_executable");
});

test("evaluateStructuredRecoveryPolicy and builder produce one bounded dependency repair plan", () => {
  const contract: MissionCompletionContract = {
    executionStyle: true,
    requireRealSideEffect: true,
    requireTargetPathTouch: false,
    requireArtifactMutation: false,
    requireReadinessProof: false,
    requireBrowserProof: false,
    requireBrowserOpenProof: false,
    requireProcessStopProof: false,
    targetPathHints: []
  };
  const result = buildTaskResult([
    buildBlockedMissingDependencyShellResult("shell_missing_dependency_1")
  ]);
  const snapshot = buildAutonomousRecoverySnapshot({
    result,
    missionContract: contract,
    missingRequirements: resolveMissingMissionRequirements(contract, {
      realSideEffects: 0,
      targetPathTouches: 0,
      artifactMutations: 0,
      readinessProofs: 0,
      browserProofs: 0,
      browserOpenProofs: 0,
      processStopProofs: 0
    })
  });

  const decision = evaluateStructuredRecoveryPolicy({
    snapshot,
    attemptCounts: new Map()
  });
  const executionPlan = buildStructuredRecoveryExecutionPlan({
    overarchingGoal: "Build the app and leave it working.",
    missionRequiresBrowserProof: false,
    result,
    decision,
    trackedManagedProcessLeaseId: null,
    trackedManagedProcessStartContext: null,
    trackedLoopbackTarget: null
  });

  assert.equal(decision.outcome, "attempt_repair");
  assert.equal(decision.optionId, "repair_missing_dependency");
  assert.ok(executionPlan && "nextUserInput" in executionPlan);
  assert.match(executionPlan?.nextUserInput ?? "", /\[STRUCTURED_RECOVERY_OPTION:repair_missing_dependency\]/i);
  assert.match(executionPlan?.nextUserInput ?? "", /@vitejs\/plugin-react/i);
  assert.match(executionPlan?.nextUserInput ?? "", /npm install\s+"?@vitejs\/plugin-react"?/i);
});

test("buildStructuredRecoveryExecutionPlan fails closed when a parsed dependency name is not shell-safe", () => {
  const contract: MissionCompletionContract = {
    executionStyle: true,
    requireRealSideEffect: true,
    requireTargetPathTouch: false,
    requireArtifactMutation: false,
    requireReadinessProof: false,
    requireBrowserProof: false,
    requireBrowserOpenProof: false,
    requireProcessStopProof: false,
    targetPathHints: []
  };
  const result = buildTaskResult([
    {
      ...buildBlockedMissingDependencyShellResult("shell_missing_dependency_unsafe"),
      output: `Cannot find module "@vitejs/plugin-react; rm -rf /"`
    }
  ]);
  const snapshot = buildAutonomousRecoverySnapshot({
    result,
    missionContract: contract,
    missingRequirements: resolveMissingMissionRequirements(contract, {
      realSideEffects: 0,
      targetPathTouches: 0,
      artifactMutations: 0,
      readinessProofs: 0,
      browserProofs: 0,
      browserOpenProofs: 0,
      processStopProofs: 0
    })
  });
  const decision = evaluateStructuredRecoveryPolicy({
    snapshot,
    attemptCounts: new Map()
  });
  const executionPlan = buildStructuredRecoveryExecutionPlan({
    overarchingGoal: "Build the app and leave it working.",
    missionRequiresBrowserProof: false,
    result,
    decision,
    trackedManagedProcessLeaseId: null,
    trackedManagedProcessStartContext: null,
    trackedLoopbackTarget: null
  });

  assert.ok(executionPlan && "reason" in executionPlan);
  assert.match(executionPlan?.reason ?? "", /not shell-safe/i);
});

test("buildStructuredRecoveryExecutionPlan uses the approved start_process context for stopped-target restart recovery", () => {
  const result = buildTaskResult([
    {
      action: {
        id: "action_restart_start_context",
        type: "start_process",
        description: "restart the local server",
        params: {
          command: "npm run dev -- --hostname 127.0.0.1 --port 61909",
          cwd: "C:\\Users\\testuser\\Desktop\\Detroit City"
        },
        estimatedCostUsd: 0.28
      },
      mode: "escalation_path",
      approved: true,
      output: "Process started.",
      executionStatus: "success",
      executionMetadata: {
        processLeaseId: "proc_restart_context_1",
        processLifecycleStatus: "PROCESS_STARTED",
        processRequestedHost: "127.0.0.1",
        processRequestedPort: 61909,
        processRequestedUrl: "http://127.0.0.1:61909"
      },
      blockedBy: [],
      violations: [],
      votes: []
    },
    {
      action: {
        id: "action_restart_check_context",
        type: "check_process",
        description: "check the managed process",
        params: {
          leaseId: "proc_restart_context_1"
        },
        estimatedCostUsd: 0.04
      },
      mode: "escalation_path",
      approved: true,
      output: "Process stopped: lease proc_restart_context_1.",
      executionStatus: "success",
      executionMetadata: {
        processLeaseId: "proc_restart_context_1",
        processLifecycleStatus: "PROCESS_STOPPED"
      },
      blockedBy: [],
      violations: [],
      votes: []
    }
  ]);

  const executionPlan = buildStructuredRecoveryExecutionPlan({
    overarchingGoal: "Build the Detroit City app and leave it open in the browser.",
    missionRequiresBrowserProof: true,
    result,
    decision: {
      outcome: "attempt_repair",
      recoveryClass: "TARGET_NOT_RUNNING",
      optionId: "restart_target_then_reverify",
      allowedRung: "bounded_repair_iteration",
      fingerprint: "restart_target_then_reverify:detroit_city",
      attemptsUsed: 0,
      maxAttempts: 2,
      cooldownIterations: 0,
      builderPending: false,
      reason: "test fixture permits one bounded restart"
    },
    trackedManagedProcessLeaseId: "proc_restart_context_1",
    trackedManagedProcessStartContext: null,
    trackedLoopbackTarget: {
      url: "http://127.0.0.1:61909",
      host: "127.0.0.1",
      port: 61909
    }
  });

  assert.ok(executionPlan && "nextUserInput" in executionPlan);
  assert.match(
    executionPlan?.nextUserInput ?? "",
    /^start_process cmd="npm run dev -- --hostname 127\.0\.0\.1 --port 61909" cwd="C:\\\\Users\\\\testuser\\\\Desktop\\\\Detroit City"\./i
  );
  assert.match(executionPlan?.nextUserInput ?? "", /prove HTTP readiness at http:\/\/127\.0\.0\.1:61909/i);
  assert.match(executionPlan?.nextUserInput ?? "", /Do not use shell_command, write_file, scaffold, install/i);
});

test("buildStructuredRecoveryExecutionPlan reuses tracked start context across later check_process iterations", () => {
  const result = buildTaskResult([
    {
      action: {
        id: "action_restart_check_context_cross_iteration",
        type: "check_process",
        description: "check the managed process",
        params: {
          leaseId: "proc_restart_context_2"
        },
        estimatedCostUsd: 0.04
      },
      mode: "escalation_path",
      approved: true,
      output: "Process stopped: lease proc_restart_context_2.",
      executionStatus: "success",
      executionMetadata: {
        processLeaseId: "proc_restart_context_2",
        processLifecycleStatus: "PROCESS_STOPPED"
      },
      blockedBy: [],
      violations: [],
      votes: []
    }
  ]);

  const executionPlan = buildStructuredRecoveryExecutionPlan({
    overarchingGoal: "Build the Detroit City app and leave it open in the browser.",
    missionRequiresBrowserProof: true,
    result,
    decision: {
      outcome: "attempt_repair",
      recoveryClass: "TARGET_NOT_RUNNING",
      optionId: "restart_target_then_reverify",
      allowedRung: "bounded_repair_iteration",
      fingerprint: "restart_target_then_reverify:detroit_city_cross_iteration",
      attemptsUsed: 0,
      maxAttempts: 2,
      cooldownIterations: 0,
      builderPending: false,
      reason: "test fixture permits one bounded restart"
    },
    trackedManagedProcessLeaseId: "proc_restart_context_2",
    trackedManagedProcessStartContext: {
      leaseId: "proc_restart_context_2",
      command: "npm run dev -- --hostname 127.0.0.1 --port 56382",
      cwd: "C:\\Users\\testuser\\Desktop\\Detroit City"
    },
    trackedLoopbackTarget: {
      url: "http://127.0.0.1:56382",
      host: "127.0.0.1",
      port: 56382
    }
  });

  assert.ok(executionPlan && "nextUserInput" in executionPlan);
  assert.match(
    executionPlan?.nextUserInput ?? "",
    /^start_process cmd="npm run dev -- --hostname 127\.0\.0\.1 --port 56382" cwd="C:\\\\Users\\\\testuser\\\\Desktop\\\\Detroit City"\./i
  );
  assert.match(executionPlan?.nextUserInput ?? "", /Do not use shell_command, write_file, scaffold, install/i);
  assert.doesNotMatch(executionPlan?.nextUserInput ?? "", /restart the local server once if needed/i);
});

test("resolveStructuredRecoveryRuntimeDecision does not relaunch localhost for shutdown-only runtime inspection turns", () => {
  const goal =
    'please inspect and see if "Detroit City Two" is still running, do this end to end';
  const missionContract = buildMissionCompletionContract(goal);
  const result = {
    ...buildTaskResult([
      buildBlockedStartProcessPortInUseResult("start_process_shutdown_inspection_conflict")
    ]),
    task: {
      id: "task_shutdown_inspection_conflict",
      goal,
      userInput: [
        "Current tracked workspace in this chat:",
        "- Root path: C:\\Users\\testuser\\OneDrive\\Desktop\\Detroit City Two",
        "- Preview process lease: proc_detroit_city_two",
        "",
        "Current user request:",
        goal
      ].join("\n"),
      createdAt: new Date().toISOString()
    }
  } satisfies TaskRunResult;

  const decision = resolveStructuredRecoveryRuntimeDecision({
    overarchingGoal: goal,
    missionContract,
    missingRequirements: resolveMissingMissionRequirements(missionContract, {
      realSideEffects: 0,
      targetPathTouches: 0,
      artifactMutations: 0,
      readinessProofs: 0,
      browserProofs: 0,
      browserOpenProofs: 0,
      processStopProofs: 0
    }),
    result,
    attemptCounts: new Map(),
    trackedManagedProcessLeaseId: "proc_detroit_city_two",
    trackedManagedProcessStartContext: {
      leaseId: "proc_detroit_city_two",
      command: "npm run dev -- --hostname 127.0.0.1 --port 3000",
      cwd: "C:\\Users\\testuser\\OneDrive\\Desktop\\Detroit City Two"
    },
    trackedLoopbackTarget: {
      url: "http://127.0.0.1:3000",
      host: "127.0.0.1",
      port: 3000
    }
  });

  assert.deepEqual(decision, { outcome: "none" });
});

test("resolveStructuredRecoveryRuntimeDecision keeps alternate-port recovery for browser-open build goals", () => {
  const goal =
    'Create a nextjs landing page called "Detroit City Two", run it locally, and leave it open in the browser so I can review it.';
  const missionContract = buildMissionCompletionContract(goal);
  const result = {
    ...buildTaskResult([
      buildBlockedStartProcessPortInUseResult("start_process_build_conflict")
    ]),
    task: {
      id: "task_browser_open_build_conflict",
      goal,
      userInput: [
        "Current user request:",
        goal
      ].join("\n"),
      createdAt: new Date().toISOString()
    }
  } satisfies TaskRunResult;

  const decision = resolveStructuredRecoveryRuntimeDecision({
    overarchingGoal: goal,
    missionContract,
    missingRequirements: resolveMissingMissionRequirements(missionContract, {
      realSideEffects: 1,
      targetPathTouches: 1,
      artifactMutations: 1,
      readinessProofs: 0,
      browserProofs: 0,
      browserOpenProofs: 0,
      processStopProofs: 0
    }),
    result,
    attemptCounts: new Map(),
    trackedManagedProcessLeaseId: null,
    trackedManagedProcessStartContext: null,
    trackedLoopbackTarget: null
  });

  assert.equal(decision.outcome, "retry");
  assert.equal(decision.recoveryClass, "PROCESS_PORT_IN_USE");
  assert.match(decision.nextUserInput, /probe_http url="http:\/\/127\.0\.0\.1:63292"/i);
});

test("evaluateAutonomousNextStep reuses tracked start context when check_process later proves the lease stopped", async () => {
  const result = buildTaskResult([
    {
      action: {
        id: "check_process_model_policy_restart_context",
        type: "check_process",
        description: "check the managed process",
        params: {
          leaseId: "proc_autonomy_modules_2"
        },
        estimatedCostUsd: 0.04
      },
      mode: "escalation_path",
      approved: true,
      output: "Process stopped: lease proc_autonomy_modules_2.",
      executionStatus: "success",
      executionMetadata: {
        processLeaseId: "proc_autonomy_modules_2",
        processLifecycleStatus: "PROCESS_STOPPED"
      },
      blockedBy: [],
      violations: [],
      votes: []
    }
  ]);

  const nextStep = await evaluateAutonomousNextStep(
    { completeJson: async () => ({ isGoalMet: true, reasoning: "unused", nextUserInput: "" }) } as never,
    DEFAULT_BRAIN_CONFIG,
    "Create a local app, prove localhost readiness, and leave it open in the browser.",
    result,
    {
      realSideEffects: 1,
      targetPathTouches: 1,
      artifactMutations: 1,
      readinessProofs: 0,
      browserProofs: 0,
      browserOpenProofs: 0,
      processStopProofs: 0
    },
    "proc_autonomy_modules_2",
    {
      leaseId: "proc_autonomy_modules_2",
      command: "npm run dev -- --hostname 127.0.0.1 --port 56382",
      cwd: "C:\\Users\\testuser\\Desktop\\Detroit City"
    },
    {
      url: "http://127.0.0.1:56382",
      host: "127.0.0.1",
      port: 56382
    }
  );

  assert.equal(nextStep.isGoalMet, false);
  assert.match(
    nextStep.nextUserInput,
    /^start_process cmd="npm run dev -- --hostname 127\.0\.0\.1 --port 56382" cwd="C:\\\\Users\\\\testuser\\\\Desktop\\\\Detroit City"\./i
  );
  assert.match(nextStep.nextUserInput, /Do not use shell_command, write_file, scaffold, install, or other file-mutation actions/i);
});

test("evaluateAutonomousNextStep enriches generic framework restart continuations with tracked workspace and loopback context", async () => {
  const result = buildTaskResult([
    {
      action: {
        id: "write_page_detroit_city_two",
        type: "write_file",
        description: "write the Detroit City Two page",
        params: {
          path: "C:\\Users\\testuser\\OneDrive\\Desktop\\Detroit City Two\\app\\page.js",
          content: "export default function Page() { return null; }"
        },
        estimatedCostUsd: 0.02
      },
      mode: "escalation_path",
      approved: true,
      output: "Page updated.",
      executionStatus: "success",
      blockedBy: [],
      violations: [],
      votes: []
    }
  ]);

  const nextStep = await evaluateAutonomousNextStep(
    {
      completeJson: async () => ({
        isGoalMet: false,
        reasoning: "restart the tracked preview",
        nextUserInput:
          "The app is not running, so restart the Next.js landing page from the project on the Desktop, fix any startup error if needed, wait until the local URL is actually ready, then open it in a browser and leave that browser window open for review. After that, report the Desktop project path and the live URL."
      })
    } as never,
    DEFAULT_BRAIN_CONFIG,
    'I want you to create a nextjs landing page, with 4 sections called "Detroit City Two" and there should be a footer and header, a gritty feeling design, and you need to do this end to end and put it on my desktop, then leave it open in the browser so i can review it.',
    result,
    {
      realSideEffects: 1,
      targetPathTouches: 1,
      artifactMutations: 1,
      readinessProofs: 0,
      browserProofs: 0,
      browserOpenProofs: 0,
      processStopProofs: 0
    },
    "proc_detroit_city_two",
    {
      leaseId: "proc_detroit_city_two",
      command: "npm run dev -- --hostname 127.0.0.1 --port 55773",
      cwd: "C:\\Users\\testuser\\OneDrive\\Desktop\\Detroit City Two"
    },
    {
      url: "http://127.0.0.1:55773",
      host: "127.0.0.1",
      port: 55773
    }
  );

  assert.equal(nextStep.isGoalMet, false);
  assert.match(
    nextStep.nextUserInput,
    /Reuse the existing project at `C:\\Users\\testuser\\OneDrive\\Desktop\\Detroit City Two`/i
  );
  assert.match(
    nextStep.nextUserInput,
    /Reuse the tracked loopback target http:\/\/127\.0\.0\.1:55773/i
  );
  assert.match(nextStep.nextUserInput, /restart the Next\.js landing page from the project on the Desktop/i);
});

test("evaluateAutonomousNextStep enriches runtime shutdown verification continuations with tracked inspect-first context", async () => {
  const result = buildTaskResult([
    {
      action: {
        id: "check_shutdown_status_detroit_city_two",
        type: "check_process",
        description: "check the tracked Detroit City Two process",
        params: {
          leaseId: "proc_detroit_city_two"
        },
        estimatedCostUsd: 0.04
      },
      mode: "escalation_path",
      approved: false,
      output: "Process state unavailable in this run.",
      executionStatus: "blocked",
      blockedBy: ["resource"],
      violations: [],
      votes: []
    }
  ]);

  const nextStep = await evaluateAutonomousNextStep(
    {
      completeJson: async () => ({
        isGoalMet: false,
        reasoning: "need a narrow shutdown verification step",
        nextUserInput:
          'Check whether the "Detroit City Two" server is currently running, stop the exact matching process if it is, and verify end to end that no server process remains listening. Use execution evidence only from this run. Report the matched process details, the stop action taken, and the verification result. If you cannot perform or verify the shutdown in this run, state that explicitly and do not claim success.'
      })
    } as never,
    DEFAULT_BRAIN_CONFIG,
    'did you make sure you shut down "Detroit City Two" so that the server is no longer running? Please do this end to end - check and make sure. If it\'s complete then you succeeded.',
    result,
    {
      realSideEffects: 0,
      targetPathTouches: 0,
      artifactMutations: 0,
      readinessProofs: 0,
      browserProofs: 0,
      browserOpenProofs: 0,
      processStopProofs: 0
    },
    "proc_detroit_city_two",
    {
      leaseId: "proc_detroit_city_two",
      command: "npm run dev -- --hostname 127.0.0.1 --port 59025",
      cwd: "C:\\Users\\testuser\\OneDrive\\Desktop\\Detroit City Two"
    },
    {
      url: "http://127.0.0.1:59025",
      host: "127.0.0.1",
      port: 59025
    }
  );

  assert.equal(nextStep.isGoalMet, false);
  assert.match(
    nextStep.nextUserInput,
    /AUTONOMOUS_RUNTIME_INSPECTION_TARGET \{\"rootPath\":\"C:\\\\Users\\\\testuser\\\\OneDrive\\\\Desktop\\\\Detroit City Two\",\"previewUrl\":\"http:\/\/127\.0\.0\.1:59025\",\"previewProcessLeaseId\":\"proc_detroit_city_two\"\}/i
  );
  assert.match(
    nextStep.nextUserInput,
    /Treat `C:\\Users\\testuser\\OneDrive\\Desktop\\Detroit City Two` as the exact runtime target/i
  );
  assert.match(nextStep.nextUserInput, /Use inspect_workspace_resources first/i);
  assert.match(
    nextStep.nextUserInput,
    /Do not create, modify, build, install, scaffold, or rename project files for this turn/i
  );
  assert.match(
    nextStep.nextUserInput,
    /Treat http:\/\/127\.0\.0\.1:59025 as the last tracked preview URL only/i
  );
});

test("evaluateAutonomousNextStep completes shutdown verification from one inspection when no live preview holder remains", async () => {
  const goal =
    'did you make sure you shut down "Detroit City Two" so that the server is no longer running? Please do this end to end - check and make sure. If it\'s complete then you succeeded.';
  const result = {
    ...buildTaskResult([
      buildApprovedInspectWorkspaceResourcesResult(
        "inspect_workspace_shutdown_complete",
        {
          inspectionOwnershipClassification: "orphaned_attributable",
          inspectionRecommendedNextAction: "clarify_before_exact_non_preview_shutdown",
          inspectionStaleBrowserSessionIds: "browser_session:detroit_two",
          inspectionStalePreviewProcessLeaseIds: "proc_detroit_two",
          inspectionUntrackedCandidatePids: "58260",
          inspectionUntrackedCandidateKinds: "shell_workspace",
          inspectionUntrackedCandidateNames: "powershell.exe",
          inspectionUntrackedCandidateConfidences: "high",
          inspectionUntrackedCandidateReasons: "command_line_matches_target_path"
        }
      )
    ]),
    task: {
      id: "task_shutdown_inspection_complete",
      goal,
      userInput: [
        "Current tracked workspace in this chat:",
        "- Root path: C:\\Users\\testuser\\Desktop\\Detroit City Two",
        "- Preview process lease: proc_detroit_two",
        "",
        "Current user request:",
        goal
      ].join("\n"),
      createdAt: new Date().toISOString()
    }
  } satisfies TaskRunResult;

  const nextStep = await evaluateAutonomousNextStep(
    {
      completeJson: async () => {
        throw new Error("runtime shutdown verification should complete from inspection evidence");
      }
    } as never,
    DEFAULT_BRAIN_CONFIG,
    goal,
    result,
    {
      realSideEffects: 0,
      targetPathTouches: 0,
      artifactMutations: 0,
      readinessProofs: 0,
      browserProofs: 0,
      browserOpenProofs: 0,
      processStopProofs: 0
    },
    "proc_detroit_two",
    {
      leaseId: "proc_detroit_two",
      command: "npm run dev -- --hostname 127.0.0.1 --port 3000",
      cwd: "C:\\Users\\testuser\\Desktop\\Detroit City Two"
    },
    {
      url: "http://127.0.0.1:3000",
      host: "127.0.0.1",
      port: 3000
    }
  );

  assert.equal(nextStep.isGoalMet, true);
  assert.equal(nextStep.nextUserInput, "");
  assert.match(nextStep.reasoning, /does not appear to still be running/i);
  assert.match(nextStep.reasoning, /powershell\.exe \(pid 58260\)/i);
});

test("evaluateAutonomousNextStep keeps shutdown verification open when a current browser session still exists", async () => {
  const goal =
    'did you make sure you shut down "Detroit City Two" so that the server is no longer running? Please do this end to end - check and make sure. If it\'s complete then you succeeded.';
  const result = buildTaskResult([
    buildApprovedInspectWorkspaceResourcesResult(
      "inspect_workspace_shutdown_browser_open",
      {
        inspectionOwnershipClassification: "current_tracked",
        inspectionRecommendedNextAction: "stop_exact_tracked_holders",
        inspectionBrowserSessionIds: "browser_session:detroit_two",
        inspectionPreviewProcessLeaseIds: "",
        inspectionStaleBrowserSessionIds: "",
        inspectionOrphanedBrowserSessionIds: ""
      }
    )
  ]);

  const nextStep = await evaluateAutonomousNextStep(
    {
      completeJson: async () => ({
        isGoalMet: false,
        reasoning: "need to finish shutdown verification",
        nextUserInput: "Inspect the tracked runtime again and close anything still open."
      })
    } as never,
    DEFAULT_BRAIN_CONFIG,
    goal,
    result,
    {
      realSideEffects: 0,
      targetPathTouches: 0,
      artifactMutations: 0,
      readinessProofs: 0,
      browserProofs: 0,
      browserOpenProofs: 0,
      processStopProofs: 0
    },
    "proc_detroit_two",
    {
      leaseId: "proc_detroit_two",
      command: "npm run dev -- --hostname 127.0.0.1 --port 3000",
      cwd: "C:\\Users\\testuser\\Desktop\\Detroit City Two"
    },
    {
      url: "http://127.0.0.1:3000",
      host: "127.0.0.1",
      port: 3000
    }
  );

  assert.equal(nextStep.isGoalMet, false);
  assert.match(nextStep.nextUserInput, /Inspect the tracked runtime again and close anything still open\./i);
});

test("evaluateAutonomousNextStep requires open_browser when the goal says to leave the preview open", async () => {
  const result = buildTaskResult([
    buildApprovedProbeHttpReadyResult(
      "probe_http_browser_open_needed",
      "http://127.0.0.1:56382"
    )
  ]);

  const nextStep = await evaluateAutonomousNextStep(
    {
      completeJson: async () => {
        throw new Error("browser-open completion should not fall back to the model");
      }
    } as never,
    DEFAULT_BRAIN_CONFIG,
    "Create a local app, prove localhost readiness, and leave it open in the browser.",
    result,
    {
      realSideEffects: 1,
      targetPathTouches: 1,
      artifactMutations: 1,
      readinessProofs: 1,
      browserProofs: 0,
      browserOpenProofs: 0,
      processStopProofs: 0
    },
    "proc_autonomy_modules_browser_open",
    {
      leaseId: "proc_autonomy_modules_browser_open",
      command: "npm run dev -- --hostname 127.0.0.1 --port 56382",
      cwd: "C:\\Users\\testuser\\Desktop\\Detroit City"
    },
    {
      url: "http://127.0.0.1:56382",
      host: "127.0.0.1",
      port: 56382
    }
  );

  assert.equal(nextStep.isGoalMet, false);
  assert.match(
    nextStep.nextUserInput,
    /^open_browser url="http:\/\/127\.0\.0\.1:56382" rootPath="C:\\\\Users\\\\testuser\\\\Desktop\\\\Detroit City" previewProcessLeaseId="proc_autonomy_modules_browser_open"\./i
  );
});

test("evaluateStructuredRecoveryPolicy stops when a bounded repair fingerprint exhausts its budget", () => {
  const signal = {
    recoveryClass: "DEPENDENCY_MISSING" as const,
    provenance: "executor_mechanical" as const,
    sourceCode: "ACTION_EXECUTION_FAILED" as const,
    actionType: "shell_command" as const,
    realm: "shell",
    detail: "A dependency is missing."
  };
  const optionId = "repair_missing_dependency";
  const fingerprint = buildRecoveryAttemptFingerprint(signal, optionId);

  const decision = evaluateStructuredRecoveryPolicy({
    snapshot: {
      missionStopLimitReached: false,
      failureSignals: [signal],
      proofGaps: ["REAL_SIDE_EFFECT_MISSING"],
      repairOptions: [
        {
          optionId,
          allowedRung: "bounded_repair_iteration",
          budgetHint: "single_repair_attempt",
          detail: "Install only the missing dependency."
        }
      ],
      remainingBudgetHint: "single_repair_attempt",
      environmentFacts: {}
    },
    attemptCounts: new Map([[fingerprint, 1]])
  });

  assert.equal(decision.outcome, "stop");
  assert.equal(decision.fingerprint, fingerprint);
  assert.match(decision.reason, /budget is exhausted/i);
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

test("humanizeAutonomousStopReason keeps provider pressure and timeout failures specific", () => {
  const rateLimited = humanizeAutonomousStopReason(
    "[reasonCode=AUTONOMOUS_TASK_EXECUTION_FAILED] Iteration 1 failed before completion: OpenAI returned 429 rate limit exceeded."
  );
  const timedOut = humanizeAutonomousStopReason(
    "[reasonCode=AUTONOMOUS_TASK_EXECUTION_FAILED] Iteration 2 failed before completion: request timed out while waiting for verification."
  );
  const droppedConnection = humanizeAutonomousStopReason(
    "[reasonCode=AUTONOMOUS_TASK_EXECUTION_FAILED] Iteration 3 failed before completion: fetch failed with ECONNRESET."
  );

  assert.match(rateLimited, /rate limit/i);
  assert.match(rateLimited, /capacity is available/i);
  assert.match(timedOut, /timed out/i);
  assert.match(timedOut, /bounded timeout/i);
  assert.match(droppedConnection, /connection/i);
  assert.match(droppedConnection, /dependency is stable/i);
});

test("agentLoopProgress renders human-first working, verification, and narrow recovery messages", () => {
  const working = buildWorkingStateMessage(
    2,
    "Please organize the sample-company project folders you made earlier into a folder called sample-web-projects and keep going until the move is actually verified."
  );
  const verification = buildVerificationStateMessage([MISSION_REQUIREMENT_PROCESS_STOP]);
  const recovery = buildWorkspaceRecoveryStateMessage(buildWorkspaceRecoverySignalFixture({
    recommendedAction: "stop_exact_tracked_holders",
    matchedRuleId: "workspace_recovery_exact_preview_holder",
    reasoning: "The exact tracked preview holders are still blocking the folder move.",
    question: "Do you want me to continue?",
    recoveryInstruction: "Stop only the exact tracked preview holders, then retry the move.",
    trackedPreviewProcessLeaseIds: ["proc_preview_1"],
    recoveredExactHolderPids: [4242],
    blockedFolderPaths: ["C:\\Users\\testuser\\Desktop\\sample-company"],
    exactNonPreviewHolders: []
  }));

  assert.equal(
    working,
    "I'm organizing the project folders and checking what can move safely now (step 2)."
  );
  assert.match(verification, /cleanup proof/i);
  assert.match(verification, /preview stack was actually shut down/i);
  assert.match(recovery, /exact tracked holders/i);
  assert.match(recovery, /narrow shutdown path/i);
});

test("agentLoopProgress renders bounded structured recovery status updates", () => {
  assert.equal(
    buildStructuredRecoveryStateMessage("DEPENDENCY_MISSING"),
    "I found a missing dependency. I'm doing one bounded repair and then retrying the original step."
  );
  assert.match(
    buildStructuredRecoveryStateMessage("PROCESS_PORT_IN_USE"),
    /free loopback port/i
  );
});

test("agentLoopProgress keeps edit and generic autonomous work calmer than raw prompt echoes", () => {
  const editMessage = buildWorkingStateMessage(
    3,
    "Please turn the hero into a slider and keep the preview aligned with the current page."
  );
  const genericMessage = buildWorkingStateMessage(
    1,
    "Take this from start to finish."
  );

  assert.equal(
    editMessage,
    "I'm updating the current page and keeping the preview in sync now (step 3)."
  );
  assert.equal(
    genericMessage,
    "I'm working through the next step now (step 1)."
  );
});

test("agentLoopProgress turns low-signal retry reasons into calmer continuation text", () => {
  const organizeRetry = buildRetryingStateMessage(
    "keep executing",
    "Every folder with the name beginning in sample-company should go in sample-folder on my desktop."
  );
  const verifyRetry = buildRetryingStateMessage(
    "Summarize what was built and verify expected files.",
    "Please create a sample landing page and leave it open for me."
  );

  assert.equal(
    organizeRetry,
    "I'm continuing the folder move now and checking what changed after each step."
  );
  assert.equal(
    verifyRetry,
    "I'm moving into the next verification step now so I can confirm the result cleanly."
  );
});

test("agentLoopProgress and stopReasonText keep bounded clarification and stalled-stop language human", () => {
  const clarification = buildWorkspaceRecoveryStateMessage(buildWorkspaceRecoverySignalFixture({
    recommendedAction: "clarify_before_likely_non_preview_shutdown",
    matchedRuleId: "workspace_recovery_likely_non_preview_holder_set",
    reasoning: "A small local editor and shell set still looks tied to the blocked folders.",
    question: "Do you want me to stop just those likely holders and retry the move?",
    recoveryInstruction: "Ask before stopping the likely inspected holder set.",
    untrackedCandidatePids: [8810, 8811],
    blockedFolderPaths: ["C:\\Users\\testuser\\Desktop\\sample-company"],
    exactNonPreviewHolders: []
  }));
  const stalled = humanizeAutonomousStopReason(
    `[reasonCode=${EXECUTION_STYLE_STALL_REASON_CODE}] Missing mission requirements: BROWSER_PROOF.`
  );

  assert.match(clarification, /I found one likely local blocker|I found possible blockers|I hit a blocker/i);
  assert.doesNotMatch(clarification, /Stop-Process|taskkill|killall|pkill/i);
  assert.match(stalled, /did not get browser or UI proof/i);
  assert.match(stalled, /next step:/i);
});
