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
        cwd: "C:\\Users\\benac\\OneDrive\\Desktop\\Calm Drone"
      },
      estimatedCostUsd: 0.08
    },
    mode: "escalation_path",
    approved: false,
    output:
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@vitejs/plugin-react' imported from C:\\Users\\benac\\OneDrive\\Desktop\\Calm Drone\\vite.config.js",
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

test("buildMissionCompletionContract does not force localhost readiness for a static browser preview request", () => {
  const contract = buildMissionCompletionContract(
    "Build a tech landing page on my desktop, create a folder called drone-company, and leave it open in a browser for me."
  );

  assert.equal(contract.executionStyle, true);
  assert.equal(contract.requireRealSideEffect, true);
  assert.equal(contract.requireReadinessProof, false);
  assert.equal(contract.requireBrowserProof, false);
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

test("buildAutonomousRecoverySnapshot derives generic recovery classes and proof gaps", () => {
  const contract: MissionCompletionContract = {
    executionStyle: true,
    requireRealSideEffect: true,
    requireTargetPathTouch: false,
    requireArtifactMutation: false,
    requireReadinessProof: true,
    requireBrowserProof: false,
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
      processStopProofs: 0
    },
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
    trackedLoopbackTarget: null
  });

  assert.equal(decision.outcome, "attempt_repair");
  assert.equal(decision.optionId, "repair_missing_dependency");
  assert.ok(executionPlan && "nextUserInput" in executionPlan);
  assert.match(executionPlan?.nextUserInput ?? "", /\[STRUCTURED_RECOVERY_OPTION:repair_missing_dependency\]/i);
  assert.match(executionPlan?.nextUserInput ?? "", /@vitejs\/plugin-react/i);
  assert.match(executionPlan?.nextUserInput ?? "", /npm install\s+"?@vitejs\/plugin-react"?/i);
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
    "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects and keep going until the move is actually verified."
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
    blockedFolderPaths: ["C:\\Users\\testuser\\Desktop\\drone-company"],
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
    "Every folder with the name beginning in drone-company should go in drone-folder on my desktop."
  );
  const verifyRetry = buildRetryingStateMessage(
    "Summarize what was built and verify expected files.",
    "Please create a drone landing page and leave it open for me."
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
    blockedFolderPaths: ["C:\\Users\\testuser\\Desktop\\drone-company"],
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
