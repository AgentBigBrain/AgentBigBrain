/**
 * @fileoverview Shared model-policy helpers for autonomous loop next-step and proactive-goal evaluation.
 */

import {
  AutonomousNextStepModelOutput,
  ModelClient,
  ProactiveGoalModelOutput
} from "../../models/types";
import { BrainConfig } from "../config";
import { selectModelForRole } from "../modelRouting";
import { TaskRunResult } from "../types";
import {
  buildAutonomousRecoverySnapshot,
  MISSION_REQUIREMENT_BROWSER_OPEN,
  MISSION_REQUIREMENT_PROCESS_STOP,
  type MissionCompletionContract,
  type MissionEvidenceCounters
} from "./contracts";
import { buildMissionCompletionContract } from "./missionContract";
import {
  buildManagedProcessStopRetryInput,
  countApprovedReadinessProofActions,
  resolveMissingMissionRequirements
} from "./missionEvidence";
import {
  buildManagedProcessCheckRecoveryInput,
  buildManagedProcessConcreteRestartRecoveryInput,
  buildManagedProcessPortConflictRecoveryInput,
  buildManagedProcessStillRunningRetryInput,
  buildManagedProcessStoppedRecoveryInput,
  findManagedProcessStartPortConflictFailure,
  goalExplicitlyRequiresLoopbackPort,
  hasReadinessNotReadyFailure,
  type LoopbackTargetHint
} from "./liveRunRecovery";
import { enrichAutonomousNextUserInput } from "./frameworkContinuationContext";
import { buildManagedProcessBrowserOpenRetryInput } from "./liveRunRecoveryPromptSupport";
import {
  findApprovedManagedProcessCheckResult,
  findApprovedManagedProcessStartContext,
  findApprovedManagedProcessStartLeaseId,
  type ApprovedManagedProcessStartContext
} from "./loopCleanupPolicy";
import { readRuntimeOwnershipInspectionMetadata } from "./workspaceRecoveryInspectionMetadata";

/**
 * Formats deterministic live-run completion reasoning from the mission contract.
 *
 * @param missionContract - Completion requirements for the current mission.
 * @returns Human-readable goal-met reasoning for explicit live-run contracts.
 */
export function formatLiveRunCompletionReasoning(
  missionContract: MissionCompletionContract
): string {
  if (missionContract.requireProcessStopProof) {
    if (missionContract.requireBrowserProof && missionContract.requireBrowserOpenProof) {
      return "The explicit live-run evidence contract is complete: the build flow executed, localhost readiness was proven, browser verification passed, the preview was opened and left available in the browser, and the managed process was stopped.";
    }
    return missionContract.requireBrowserProof
      ? "The explicit live-run evidence contract is complete: the build flow executed, localhost readiness was proven, browser verification passed, and the managed process was stopped."
      : missionContract.requireBrowserOpenProof
        ? "The explicit live-run evidence contract is complete: the build flow executed, localhost readiness was proven, the preview was opened and left available in the browser, and the managed process was stopped."
        : "The explicit live-run evidence contract is complete: the build flow executed, localhost readiness was proven, and the managed process was stopped.";
  }
  if (missionContract.requireBrowserProof && missionContract.requireBrowserOpenProof) {
    return "The explicit live-run evidence contract is complete: the build flow executed, localhost readiness was proven, browser verification passed, and the preview was opened and left available in the browser.";
  }
  if (missionContract.requireBrowserOpenProof) {
    return "The explicit live-run evidence contract is complete: the build flow executed, localhost readiness was proven, and the preview was opened and left available in the browser.";
  }
  if (missionContract.requireBrowserProof) {
    return "The explicit live-run evidence contract is complete: the build flow executed, localhost readiness was proven, and browser verification passed.";
  }
  return "The explicit live-run evidence contract is complete: localhost readiness was proven.";
}

/**
 * Evaluates the next autonomous step while preserving deterministic live-run recovery rules.
 *
 * @param modelClient - Model client used for planner-style next-step evaluation.
 * @param config - Runtime model-routing configuration.
 * @param overarchingGoal - Current mission goal text.
 * @param lastResult - Result from the latest autonomous-loop iteration.
 * @param missionEvidence - Cumulative deterministic mission evidence so far.
 * @param trackedManagedProcessLeaseId - Tracked managed-process lease, if any.
 * @param trackedManagedProcessStartContext - Tracked approved `start_process` context, if any.
 * @param trackedLoopbackTarget - Tracked loopback target, if any.
 * @returns Planner decision describing whether the goal is done or what to do next.
 */
export async function evaluateAutonomousNextStep(
  modelClient: ModelClient,
  config: BrainConfig,
  overarchingGoal: string,
  lastResult: TaskRunResult,
  missionEvidence: MissionEvidenceCounters,
  trackedManagedProcessLeaseId: string | null,
  trackedManagedProcessStartContext: ApprovedManagedProcessStartContext | null,
  trackedLoopbackTarget: LoopbackTargetHint | null
): Promise<AutonomousNextStepModelOutput> {
  const missionContract = buildMissionCompletionContract(overarchingGoal);
  const runtimeInspectionCompletion = resolveRuntimeInspectionCompletion(
    overarchingGoal,
    lastResult
  );
  if (runtimeInspectionCompletion) {
    return runtimeInspectionCompletion;
  }
  const missingRequirements = resolveMissingMissionRequirements(
    missionContract,
    missionEvidence
  );
  const recoverySnapshot = buildAutonomousRecoverySnapshot({
    result: lastResult,
    missionContract,
    missingRequirements
  });
  const startPortConflict = findManagedProcessStartPortConflictFailure(lastResult);
  if (missionContract.requireReadinessProof && startPortConflict) {
    if (
      startPortConflict.suggestedPort !== null &&
      !goalExplicitlyRequiresLoopbackPort(
        overarchingGoal,
        startPortConflict.requestedPort
      )
    ) {
      return {
        isGoalMet: false,
        reasoning:
          `The requested localhost port ${startPortConflict.requestedPort} was already occupied, ` +
          "so the local server needs a different free port before readiness or browser proof can continue.",
        nextUserInput: buildManagedProcessPortConflictRecoveryInput(
          startPortConflict,
          missionContract.requireBrowserProof || missionContract.requireBrowserOpenProof
        )
      };
    }
  }

  const startedManagedProcessLeaseId = findApprovedManagedProcessStartLeaseId(lastResult);
  const checkedManagedProcess = findApprovedManagedProcessCheckResult(lastResult);
  const approvedStartContext =
    findApprovedManagedProcessStartContext(lastResult) ?? trackedManagedProcessStartContext;
  const activeManagedProcessLeaseId =
    startedManagedProcessLeaseId ??
    checkedManagedProcess?.leaseId ??
    trackedManagedProcessLeaseId;

  if (
    missionContract.requireReadinessProof &&
    activeManagedProcessLeaseId &&
    hasReadinessNotReadyFailure(lastResult)
  ) {
    return {
      isGoalMet: false,
      reasoning: "The local process started, but localhost readiness was not proven yet.",
      nextUserInput: buildManagedProcessCheckRecoveryInput(
        activeManagedProcessLeaseId,
        trackedLoopbackTarget,
        missionContract.requireBrowserProof || missionContract.requireBrowserOpenProof
      )
    };
  }

  if (
    missionContract.requireReadinessProof &&
    checkedManagedProcess?.lifecycleStatus === "PROCESS_STILL_RUNNING" &&
    countApprovedReadinessProofActions(
      lastResult,
      missionContract.requireBrowserProof || missionContract.requireBrowserOpenProof
    ) === 0
  ) {
    return {
      isGoalMet: false,
      reasoning:
        "The managed process is still running, so the next step is to retry localhost readiness proof.",
      nextUserInput: buildManagedProcessStillRunningRetryInput(
        checkedManagedProcess.leaseId,
        missionContract.requireBrowserProof || missionContract.requireBrowserOpenProof,
        trackedLoopbackTarget
      )
    };
  }

  if (
    missionContract.requireReadinessProof &&
    checkedManagedProcess?.lifecycleStatus === "PROCESS_STOPPED" &&
    countApprovedReadinessProofActions(
      lastResult,
      missionContract.requireBrowserProof || missionContract.requireBrowserOpenProof
    ) === 0
  ) {
    return {
      isGoalMet: false,
      reasoning: "The managed process stopped before localhost readiness was proven.",
      nextUserInput:
        approvedStartContext &&
        approvedStartContext.leaseId === checkedManagedProcess.leaseId &&
        approvedStartContext.command
          ? buildManagedProcessConcreteRestartRecoveryInput(
              {
                leaseId: checkedManagedProcess.leaseId,
                command: approvedStartContext.command,
                cwd: approvedStartContext.cwd
              },
              trackedLoopbackTarget,
              missionContract.requireBrowserProof || missionContract.requireBrowserOpenProof
            )
          : buildManagedProcessStoppedRecoveryInput(
              checkedManagedProcess.leaseId,
              trackedLoopbackTarget,
              missionContract.requireBrowserProof || missionContract.requireBrowserOpenProof
            )
    };
  }

  if (
    missionContract.requireBrowserProof &&
    hasExecutionFailureCode(lastResult, "BROWSER_VERIFY_RUNTIME_UNAVAILABLE") &&
    !isPlaywrightInstallRecoveryInput(lastResult.task.userInput)
  ) {
    return {
      isGoalMet: false,
      reasoning:
        "Browser verification is still unavailable because the local Playwright runtime is not ready yet.",
      nextUserInput: buildPlaywrightInstallRecoveryInput(overarchingGoal)
    };
  }

  if (
    missionContract.requireBrowserOpenProof &&
    missingRequirements.length === 1 &&
    missingRequirements[0] === MISSION_REQUIREMENT_BROWSER_OPEN
  ) {
    return {
      isGoalMet: false,
      reasoning:
        "Local readiness is already proven. The remaining required step is to open the live preview in the browser and leave it open.",
      nextUserInput: buildManagedProcessBrowserOpenRetryInput({
        target: trackedLoopbackTarget,
        rootPath: trackedManagedProcessStartContext?.cwd ?? null,
        previewProcessLeaseId: trackedManagedProcessLeaseId
      })
    };
  }

  if (
    missionContract.requireProcessStopProof &&
    trackedManagedProcessLeaseId &&
    missingRequirements.length === 1 &&
    missingRequirements[0] === MISSION_REQUIREMENT_PROCESS_STOP
  ) {
    return {
      isGoalMet: false,
      reasoning:
        "All required build and verification proof is complete; the remaining required step is to stop the tracked managed process.",
      nextUserInput: buildManagedProcessStopRetryInput(trackedManagedProcessLeaseId)
    };
  }

  const model = selectModelForRole("planner", config);

  try {
    const systemPrompt =
      "You are the manager of an autonomous agent loop. Analyze the last task's result against the overarching goal. " +
      "Decide if the goal is completely met. If not, formulate the exact next instruction (userInput) the agent needs to perform. " +
      "Return JSON with 'isGoalMet' (boolean), 'reasoning' (string), and 'nextUserInput' (string)." +
      buildLiveRunPromptGuidance(missionContract);
    const modelOutput = await modelClient.completeJson<AutonomousNextStepModelOutput>({
      model,
      schemaName: "autonomous_next_step_v1",
      temperature: 0.1,
      systemPrompt,
      userPrompt: JSON.stringify({
        overarchingGoal,
        lastTaskInput: lastResult.task.userInput,
        lastTaskSummary: lastResult.summary,
        recoverySnapshot,
        actionResults: lastResult.actionResults.map((entry) => ({
          type: entry.action.type,
          description: entry.action.description,
          approved: entry.approved,
          executionStatus: entry.executionStatus ?? null,
          executionFailureCode: entry.executionFailureCode ?? null,
          output: entry.output,
          blockedBy: entry.blockedBy,
          executionMetadata: {
            processLifecycleStatus:
              typeof entry.executionMetadata?.processLifecycleStatus === "string"
                ? entry.executionMetadata.processLifecycleStatus
                : null,
            processStartupFailureKind:
              typeof entry.executionMetadata?.processStartupFailureKind === "string"
                ? entry.executionMetadata.processStartupFailureKind
                : null,
            processRequestedUrl:
              typeof entry.executionMetadata?.processRequestedUrl === "string"
                ? entry.executionMetadata.processRequestedUrl
                : null,
            probeUrl:
              typeof entry.executionMetadata?.probeUrl === "string"
                ? entry.executionMetadata.probeUrl
                : null,
            browserVerifyUrl:
              typeof entry.executionMetadata?.browserVerifyUrl === "string"
                ? entry.executionMetadata.browserVerifyUrl
                : null
          }
        }))
      })
    });
    return {
      ...modelOutput,
      nextUserInput: enrichAutonomousNextUserInput(
        overarchingGoal,
        modelOutput.nextUserInput,
        trackedManagedProcessStartContext,
        trackedLoopbackTarget
      )
    };
  } catch (error) {
    return {
      isGoalMet: true,
      reasoning:
        "Failed to evaluate next step via model. Terminating to prevent out-of-control loops. Error: " +
        (error as Error).message,
      nextUserInput: ""
    };
  }
}

/**
 * Evaluates the next proactive daemon goal after the current goal finishes.
 *
 * @param modelClient - Model client used for planner-style proactive goal generation.
 * @param config - Runtime model-routing configuration.
 * @param previousGoal - Goal that just completed.
 * @returns Deterministic proactive-goal output or a safe fallback.
 */
export async function evaluateProactiveAutonomousGoal(
  modelClient: ModelClient,
  config: BrainConfig,
  previousGoal: string
): Promise<ProactiveGoalModelOutput> {
  const model = selectModelForRole("planner", config);

  try {
    return await modelClient.completeJson<ProactiveGoalModelOutput>({
      model,
      schemaName: "proactive_goal_v1",
      temperature: 0.8,
      systemPrompt:
        "You are a 24/7 autonomous agent daemon. Your previous goal was just completed. Generate a logical, productive new overarching goal for yourself to work on next. It should be independent and self-contained. Return JSON with 'proactiveGoal' (string) and 'reasoning' (string).",
      userPrompt: JSON.stringify({ previousGoal })
    });
  } catch (error) {
    return {
      proactiveGoal: "Sleep and idle",
      reasoning: "Fallback proactive goal due to an error: " + (error as Error).message
    };
  }
}

/**
 * Appends live-run-specific planner guidance when the mission requires localhost or browser proof.
 *
 * @param missionContract - Mission completion contract for the current goal.
 * @returns Additional prompt text or an empty string when live-run proof is not required.
 */
function buildLiveRunPromptGuidance(missionContract: MissionCompletionContract): string {
  if (
    !(
      missionContract.requireReadinessProof ||
      missionContract.requireBrowserProof ||
      missionContract.requireBrowserOpenProof
    )
  ) {
    return "";
  }

  return (
    " For explicit localhost/live/browser verification goals, keep next steps inside governed proof actions. " +
    "Do not ask the user to manually open a browser or manually inspect localhost during the autonomous loop. " +
    "When a managed process is not running yet, request one finite next step that creates any missing helper artifact and then immediately performs the remaining live proof chain in the same task: start_process, probe_http, verify_browser, open_browser when required, and stop_process when required. " +
    "Do not return a preparatory next step that only writes a helper script or only starts the process without also asking for the remaining proof actions. " +
    "Do not replace verify_browser with shell-based Playwright commands such as npx playwright --version, npx playwright open, or npx playwright test. " +
    (missionContract.requireBrowserOpenProof
      ? "If the goal explicitly says to leave the page open, treat open_browser as required completion proof after readiness passes; verify_browser alone is not enough. "
      : "") +
    "If live proof steps are blocked or unavailable, say so plainly instead of inventing manual or shell-based fallback checks."
  );
}

const RUNTIME_PROCESS_TARGET_PATTERN =
  /\b(?:still\s+running|running|server|servers|preview(?:\s+stack|\s+server)?|process(?:es)?|localhost|loopback|port|dev\s+server)\b/i;
const RUNTIME_SHUTDOWN_VERB_PATTERN =
  /\b(?:stop|shut\s+down|turn\s+off|kill)\b/i;

/**
 * Completes inspect-first runtime-management goals from already-proven inspection evidence instead
 * of replanning a synthetic "report only" turn that can drift back into explicit-action repair.
 *
 * @param overarchingGoal - User-facing autonomous goal for the current loop.
 * @param lastResult - Latest governed task result that may already contain inspection evidence.
 * @returns Deterministic completion decision, or `null` when another governed step is still required.
 */
function resolveRuntimeInspectionCompletion(
  overarchingGoal: string,
  lastResult: TaskRunResult
): AutonomousNextStepModelOutput | null {
  const runtimeManagementRequested =
    RUNTIME_PROCESS_TARGET_PATTERN.test(overarchingGoal) &&
    (
      RUNTIME_SHUTDOWN_VERB_PATTERN.test(overarchingGoal) ||
      /\b(?:inspect|check|verify|confirm|make\s+sure|see\s+if|look\s+at)\b/i.test(overarchingGoal)
    );
  if (!runtimeManagementRequested) {
    return null;
  }

  const inspectionMetadata = readRuntimeOwnershipInspectionMetadata(lastResult);
  if (!inspectionMetadata) {
    return null;
  }

  const previewServerCandidates = inspectionMetadata.untrackedCandidates.filter(
    (candidate) => candidate.kind === "preview_server"
  );
  const nonPreviewCandidates = inspectionMetadata.untrackedCandidates.filter(
    (candidate) => candidate.kind !== "preview_server"
  );
  const hasLivePreviewHolder =
    inspectionMetadata.previewProcessLeaseIds.length > 0 ||
    inspectionMetadata.recoveredExactPreviewHolderPids.length > 0 ||
    previewServerCandidates.length > 0;
  const hasCurrentBrowserSession = inspectionMetadata.browserSessionIds.length > 0;
  const hasOrphanedBrowserSession = inspectionMetadata.orphanedBrowserSessionIds.length > 0;
  const runtimeStillActive =
    hasLivePreviewHolder || hasCurrentBrowserSession || hasOrphanedBrowserSession;
  const shutdownVerificationRequested =
    RUNTIME_PROCESS_TARGET_PATTERN.test(overarchingGoal) &&
    RUNTIME_SHUTDOWN_VERB_PATTERN.test(overarchingGoal);

  if (runtimeStillActive && shutdownVerificationRequested) {
    return null;
  }

  return {
    isGoalMet: true,
    reasoning: buildRuntimeInspectionCompletionReasoning({
      runtimeActive: runtimeStillActive,
      nonPreviewCandidates,
      shutdownVerificationRequested
    }),
    nextUserInput: ""
  };
}

/**
 * Builds one concise deterministic completion summary for inspect-only runtime-management turns.
 *
 * @param input - Inspection-state facts already proven in the current run.
 * @returns Human-readable completion reasoning for the autonomous loop.
 */
function buildRuntimeInspectionCompletionReasoning(input: {
  runtimeActive: boolean;
  nonPreviewCandidates: readonly {
    pid: number;
    kind: string | null;
    name: string | null;
  }[];
  shutdownVerificationRequested: boolean;
}): string {
  const holderSummary = formatRuntimeInspectionCandidateSummary(input.nonPreviewCandidates);
  if (input.runtimeActive) {
    return holderSummary
      ? `Inspection complete: the tracked runtime still appears active in this run, and I also found non-preview local holders tied to the same workspace (${holderSummary}).`
      : "Inspection complete: the tracked runtime still appears active in this run.";
  }

  const completionLead = input.shutdownVerificationRequested
    ? "Inspection complete: I did not find a current tracked preview process or live preview-server candidate in this run, so the tracked runtime does not appear to still be running."
    : "Inspection complete: I did not find a current tracked preview process or live preview-server candidate in this run, so the tracked runtime does not appear active.";
  return holderSummary
    ? `${completionLead} I only found non-preview local holders tied to the workspace (${holderSummary}).`
    : completionLead;
}

/**
 * Formats bounded non-preview local-holder labels for inspection-only completion summaries.
 *
 * @param candidates - Non-preview local-holder candidates recovered from runtime inspection.
 * @returns Short holder summary, or an empty string when no such candidates remain.
 */
function formatRuntimeInspectionCandidateSummary(
  candidates: readonly {
    pid: number;
    kind: string | null;
    name: string | null;
  }[]
): string {
  if (candidates.length === 0) {
    return "";
  }
  return candidates
    .map((candidate) => {
      const label = candidate.name ?? candidate.kind ?? "local process";
      return `${label} (pid ${candidate.pid})`;
    })
    .join(", ");
}

/**
 * Detects whether a task result includes a specific runtime execution failure code.
 *
 * @param result - Task result from the latest autonomous-loop iteration.
 * @param failureCode - Runtime failure code to detect.
 * @returns `true` when the task result contains the requested failure code.
 */
function hasExecutionFailureCode(result: TaskRunResult, failureCode: string): boolean {
  return result.actionResults.some((entry) =>
    !entry.approved &&
    (
      entry.executionFailureCode === failureCode ||
      entry.blockedBy.some((blockCode) => blockCode === failureCode)
    )
  );
}

/**
 * Detects whether the current subtask already attempted local Playwright installation recovery.
 *
 * @param input - Current subtask instruction text.
 * @returns `true` when the instruction is already a Playwright install recovery prompt.
 */
function isPlaywrightInstallRecoveryInput(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return (
    normalized.includes("npm install --no-save playwright") ||
    normalized.includes("npx playwright install chromium") ||
    /\binstall playwright\b/.test(normalized)
  );
}

/**
 * Builds the deterministic Playwright-install recovery prompt for browser-proof missions.
 *
 * @param overarchingGoal - Mission-level goal text.
 * @returns Explicit recovery subtask instruction.
 */
function buildPlaywrightInstallRecoveryInput(overarchingGoal: string): string {
  return (
    "Browser verification is unavailable because the local Playwright runtime is missing or " +
    "missing browser binaries. Install Playwright locally with finite shell steps if policy " +
    "allows: run `npm install --no-save playwright` and then `npx playwright install chromium`. " +
    `After install, continue this original goal and retry the localhost browser verification: "${overarchingGoal}". ` +
    "If install is blocked or fails, stop and explain plainly that browser verification could not be completed."
  );
}
