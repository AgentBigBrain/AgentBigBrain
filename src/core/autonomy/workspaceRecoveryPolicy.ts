/**
 * @fileoverview Shared workspace-lock recovery signals for autonomous retries and user clarifications.
 */

import type { TaskRunResult } from "../types";
import {
  extractBlockedFolderPaths,
  hasWorkspaceRecoveryFolderInUseSignal
} from "./workspaceRecoveryBlockedPathParsing";
import { isLocalOrganizationRecoveryContext } from "./workspaceRecoveryContextClassification";
import { readRuntimeOwnershipInspectionMetadata } from "./workspaceRecoveryInspectionMetadata";
import {
  buildManualHolderReleaseGuidance,
  buildLikelyNonPreviewHolderSetDescription,
  describeUntrackedHolderKinds,
  formatIndefiniteHolderProcessPhrase,
  formatNamedHolderExamples
} from "./workspaceRecoveryNarration";
import { buildWorkspaceRecoveryLikelyNonPreviewClarification } from "./workspaceRecoveryLikelyNonPreviewSupport";
import { buildContextualManualCleanupSignal } from "./workspaceRecoveryContextualManualCleanupSupport";
import {
  buildWorkspaceRecoveryExactNonPreviewShutdownInput,
  formatExactNonPreviewHolderLabels
} from "./workspaceRecoveryExactNonPreviewSupport";
import {
  buildExactNonPreviewClarificationSignal,
  buildInspectFirstRecoverySignal,
    buildPreviewClarificationSignal,
    buildRetryAfterInspectionSignal,
    buildStopExactTrackedRecoverySignal,
    buildStopNoLiveHoldersSignal,
    buildWorkspaceRecoveryAbortReasonFromSignal,
    selectExactNonPreviewHolderCandidates
} from "./workspaceRecoverySignalBuilders";
import {
  extractWorkspaceRecoveryContextRoots,
  extractWorkspaceRecoveryExactPreviewLeaseIds,
  workspaceRecoveryPathsOverlap
} from "./workspaceRecoveryRuntimeContext";

const LOCAL_ORGANIZATION_MOVE_COMMAND_PATTERN =
  /\b(?:move-item|mv|move)\b/i;

export type WorkspaceRecoveryRecommendedAction =
  | "stop_exact_tracked_holders"
  | "clarify_before_exact_non_preview_shutdown"
  | "clarify_before_likely_non_preview_shutdown"
  | "clarify_before_untracked_shutdown"
  | "stop_no_live_holders_found"
  | "retry_after_inspection"
  | "inspect_first";

export interface WorkspaceRecoverySignal {
  recommendedAction: WorkspaceRecoveryRecommendedAction;
  matchedRuleId: string;
  reasoning: string;
  question: string;
  recoveryInstruction: string;
  trackedPreviewProcessLeaseIds: readonly string[];
  recoveredExactHolderPids: readonly number[];
  untrackedCandidatePids: readonly number[];
  untrackedCandidateKinds: readonly string[];
  untrackedCandidateNames: readonly string[];
  blockedFolderPaths: readonly string[];
  exactNonPreviewHolders?: readonly {
    pid: number;
    kind: string | null;
    name: string | null;
  }[];
  exactNonPreviewHolderPid: number | null;
  exactNonPreviewHolderKind: string | null;
  exactNonPreviewHolderName: string | null;
}
/**
 * Returns `true` when a completed task already ran a real folder-move shell command.
 *
 * @param taskRunResult - Completed task result being evaluated.
 * @returns `true` when an approved move command already executed.
 */
export function hasApprovedWorkspaceRecoveryMoveAction(
  taskRunResult: TaskRunResult
): boolean {
  return taskRunResult.actionResults.some(
    (result) =>
      result.approved &&
      result.action.type === "shell_command" &&
      typeof result.action.params.command === "string" &&
      LOCAL_ORGANIZATION_MOVE_COMMAND_PATTERN.test(result.action.params.command)
  );
}

/**
 * Returns `true` when a completed task already stopped one exact tracked holder.
 *
 * @param taskRunResult - Completed task result being evaluated.
 * @returns `true` when a tracked-holder stop step already ran.
 */
export function hasApprovedWorkspaceRecoveryStopProcessAction(
  taskRunResult: TaskRunResult
): boolean {
  return taskRunResult.actionResults.some(
    (result) => result.approved && result.action.type === "stop_process"
  );
}

/**
 * Returns `true` when a completed task already ran one governed runtime inspection action for
 * workspace recovery.
 *
 * @param taskRunResult - Completed task result being evaluated.
 * @returns `true` when inspect_workspace_resources or inspect_path_holders already ran.
 */
export function hasApprovedWorkspaceRecoveryInspectionAction(
  taskRunResult: TaskRunResult
): boolean {
  return taskRunResult.actionResults.some(
    (result) =>
      result.approved &&
      (result.action.type === "inspect_workspace_resources" ||
        result.action.type === "inspect_path_holders")
  );
}

/**
 * Derives one bounded workspace-lock recovery signal from a completed task result.
 *
 * @param taskRunResult - Completed task result being evaluated.
 * @returns Structured recovery signal, or `null` when this task does not represent a recoverable workspace lock.
 */
export function deriveWorkspaceRecoverySignal(
  taskRunResult: TaskRunResult
): WorkspaceRecoverySignal | null {
  if (!isLocalOrganizationRecoveryContext(taskRunResult)) {
    return null;
  }
  if (!taskRunResult.actionResults.some((actionResult) => hasWorkspaceRecoveryFolderInUseSignal(actionResult))) {
    return null;
  }

  const blockedFolderPaths = extractBlockedFolderPaths(taskRunResult);
  const inspectionMetadata = readRuntimeOwnershipInspectionMetadata(taskRunResult);
  if (
    inspectionMetadata?.recommendedNextAction === "stop_exact_tracked_holders" &&
    (
      inspectionMetadata.previewProcessLeaseIds.length > 0 ||
      inspectionMetadata.recoveredExactPreviewHolderPids.length > 0
    )
  ) {
    const leaseList = inspectionMetadata.previewProcessLeaseIds
      .map((leaseId) => `leaseId="${leaseId}"`)
      .join(", ");
    const recoveredPidList = inspectionMetadata.recoveredExactPreviewHolderPids
      .map((pid) => `pid=${pid}`)
      .join(", ");
    const stopTargetList = [leaseList, recoveredPidList].filter(Boolean).join(", ");
    return buildStopExactTrackedRecoverySignal({
      matchedRuleId: "post_execution_exact_holder_folder_recovery",
      reasoning:
        "The move is blocked by exact preview holders that the runtime could attribute safely, so the next recovery step is to stop only those exact holders and retry.",
      question:
        "I couldn't move those folders yet because exact preview holders are still keeping them busy. I can shut down just those exact holders and retry the move. Do you want me to do that?",
      recoveryInstruction:
        `Recovery instruction: stop only these exact preview holders if they are still active: ${stopTargetList}. ` +
        "Use exact tracked lease ids when available, or exact recovered preview-holder pids only when inspection proved them safely enough. " +
        "Verify they stopped, then retry the original folder-organization request. Do not stop unrelated apps by name. " +
        "If those exact tracked holders are already gone, explain that clearly instead of claiming the move worked.",
      trackedPreviewProcessLeaseIds: inspectionMetadata.previewProcessLeaseIds,
      recoveredExactHolderPids: inspectionMetadata.recoveredExactPreviewHolderPids,
      blockedFolderPaths
    });
  }

  if (
    inspectionMetadata?.recommendedNextAction ===
      "clarify_before_exact_non_preview_shutdown" &&
    inspectionMetadata.ownershipClassification === "orphaned_attributable"
  ) {
    const exactNonPreviewHolders = selectExactNonPreviewHolderCandidates(
      inspectionMetadata.untrackedCandidates
    );
    if (exactNonPreviewHolders.length > 0) {
      const holderKindText = describeUntrackedHolderKinds([
        ...exactNonPreviewHolders.map(
          (exactNonPreviewHolder) =>
            exactNonPreviewHolder.kind ?? "unknown_local_process"
        )
      ]);
      const holderLabel = formatExactNonPreviewHolderLabels(exactNonPreviewHolders);
      const singleExactNonPreviewHolder =
        exactNonPreviewHolders.length === 1 ? exactNonPreviewHolders[0] : null;
      return buildExactNonPreviewClarificationSignal({
        matchedRuleId: "post_execution_exact_non_preview_holder_recovery_clarification",
        reasoning:
          `Inspection found ${
            exactNonPreviewHolders.length > 1
              ? "multiple high-confidence non-preview local holders"
              : "one high-confidence non-preview local holder"
          } tied to the blocked folders, so the next safe step is to ask before stopping only ${
            exactNonPreviewHolders.length > 1 ? "those exact processes" : "that exact process"
          } and retrying the move.`,
        question:
          `I found ${
            exactNonPreviewHolders.length > 1
              ? `${exactNonPreviewHolders.length} high-confidence local holders`
              : "one high-confidence local holder"
          } still tied to those folders: ${holderLabel}. It still looks like ${formatIndefiniteHolderProcessPhrase(holderKindText)} is holding them. If you want, I can stop just ${
            exactNonPreviewHolders.length > 1 ? "those exact processes" : "that process"
          } and retry the move. Do you want me to do that?`,
        recoveryInstruction: buildWorkspaceRecoveryExactNonPreviewShutdownInput(
          taskRunResult.task.userInput,
          exactNonPreviewHolders
        ),
        recoveredExactHolderPids: exactNonPreviewHolders.map((candidate) => candidate.pid),
        untrackedCandidatePids: exactNonPreviewHolders.map((candidate) => candidate.pid),
        blockedFolderPaths,
        exactNonPreviewHolders,
        exactNonPreviewHolderPid: singleExactNonPreviewHolder?.pid ?? null,
        exactNonPreviewHolderKind: singleExactNonPreviewHolder?.kind ?? null,
        exactNonPreviewHolderName: singleExactNonPreviewHolder?.name ?? null
      });
    }
  }
  if (inspectionMetadata?.recommendedNextAction === "clarify_before_untracked_shutdown") {
    return buildPreviewClarificationSignal({
      matchedRuleId: "post_execution_untracked_holder_recovery_clarification",
      reasoning:
        "The move is blocked by likely preview holders, but they are not exact tracked runtime resources, so explicit user confirmation is still required before shutdown.",
      question:
        "I couldn't move those folders yet because likely local preview holders are still using them, but they are not exact tracked runtime resources. If you want, I can inspect those likely holders more closely and then ask before shutting anything down. Do you want me to continue that recovery?",
      recoveryInstruction:
        "Recovery instruction: inspect the likely untracked holder processes more closely. Do not stop them automatically. " +
        "If they still are not exact tracked runtime resources, explain plainly that user confirmation is required before shutting them down.",
      untrackedCandidatePids: inspectionMetadata.untrackedCandidatePids,
      blockedFolderPaths
    });
  }
  if (
    inspectionMetadata?.recommendedNextAction ===
      "clarify_before_likely_non_preview_shutdown" &&
    inspectionMetadata.ownershipClassification === "orphaned_attributable"
  ) {
    const likelyHolderSetDescription = buildLikelyNonPreviewHolderSetDescription(
      inspectionMetadata.untrackedCandidateKinds,
      inspectionMetadata.untrackedCandidatePids.length
    );
    return buildWorkspaceRecoveryLikelyNonPreviewClarification({
      matchedRuleId: "post_execution_likely_non_preview_holder_recovery_clarification",
      reasoning:
        `Inspection found ${likelyHolderSetDescription} tied to the blocked folders, so the next safe step is to ask before stopping only that inspected set and retrying the move.`,
      leadIn:
        `I couldn't move those folders yet because ${likelyHolderSetDescription} still looks tied to them.`,
      candidatePids: inspectionMetadata.untrackedCandidatePids,
      candidateKinds: inspectionMetadata.untrackedCandidateKinds,
      candidateNames: inspectionMetadata.untrackedCandidateNames,
      blockedFolderPaths
    });
  }
  if (
    inspectionMetadata?.recommendedNextAction === "manual_orphaned_browser_cleanup" &&
    inspectionMetadata.ownershipClassification === "orphaned_attributable"
  ) {
    return buildStopNoLiveHoldersSignal({
      matchedRuleId: "post_execution_orphaned_browser_cleanup_required",
      reasoning:
        "Inspection found earlier assistant browser windows still tied to the workspace, but the runtime no longer has direct control over them and did not prove a live shutdown-safe holder for the lock.",
      question:
        "I found older assistant browser windows still tied to that workspace, but I no longer have direct runtime control over them. You may need to close those windows manually before I can continue, because I still do not have a live holder I can shut down safely from here.",
      recoveryInstruction:
        "Recovery instruction: do not retry broad shutdown or another generic inspect loop. Explain that earlier assistant browser windows are still attributable to the workspace, but the runtime no longer has direct control over them and did not prove a live shutdown-safe holder. Recommend manual browser cleanup or a narrower next step instead of guessing.",
      blockedFolderPaths
    });
  }
  if (
    inspectionMetadata?.recommendedNextAction === "manual_non_preview_holder_cleanup" &&
    inspectionMetadata.ownershipClassification === "orphaned_attributable"
  ) {
    const holderKindText = describeUntrackedHolderKinds(
      inspectionMetadata.untrackedCandidateKinds
    );
    const holderExamples = formatNamedHolderExamples(
      inspectionMetadata.untrackedCandidateNames
    );
    const manualCleanupGuidance = buildManualHolderReleaseGuidance(
      inspectionMetadata.untrackedCandidateKinds,
      inspectionMetadata.untrackedCandidateNames
    );
    const contextualManualCleanupSignal = buildContextualManualCleanupSignal({
      matchedRuleId: "post_execution_contextual_non_preview_holder_cleanup_required",
      leadingQuestionClause: "I couldn't move those folders yet because",
      untrackedCandidates: inspectionMetadata.untrackedCandidates,
      untrackedCandidatePids: inspectionMetadata.untrackedCandidatePids,
      untrackedCandidateKinds: inspectionMetadata.untrackedCandidateKinds,
      untrackedCandidateNames: inspectionMetadata.untrackedCandidateNames,
      manualCleanupGuidance,
      blockedFolderPaths
    });
    if (contextualManualCleanupSignal) {
      return contextualManualCleanupSignal;
    }
    return buildStopNoLiveHoldersSignal({
      matchedRuleId: "post_execution_non_preview_holder_cleanup_required",
      reasoning:
        "Inspection found likely non-preview local holders tied to the blocked folders, such as editor, shell, or sync processes, but did not prove an exact preview holder the runtime can shut down safely.",
      question:
        `I couldn't move those folders yet because they still look busy in ${formatIndefiniteHolderProcessPhrase(holderKindText)}, not an exact tracked preview holder.${holderExamples} ` +
        `I should not shut that down automatically from this runtime evidence alone. ${manualCleanupGuidance}`,
      recoveryInstruction:
        "Recovery instruction: do not retry broad shutdown or another generic preview-inspection loop. " +
        "Explain that inspection found likely non-preview local holders such as shell, editor, or sync processes, but did not prove an exact preview holder that can be stopped safely. " +
        `Recommend this next step instead: ${manualCleanupGuidance}`,
      untrackedCandidatePids: inspectionMetadata.untrackedCandidatePids,
      blockedFolderPaths
    });
  }

  if (inspectionMetadata?.ownershipClassification === "stale_tracked") {
    return buildRetryAfterInspectionSignal({
      matchedRuleId: "post_execution_stale_holder_records_only",
      reasoning:
        "Inspection found only stale tracked assistant resources, not live holders that can be shut down safely, so the safest next step is to retry the move once now.",
      question:
        "I checked the old assistant resources tied to that workspace, and they are already stale. I can retry the move once now in case the lock already cleared.",
      recoveryInstruction:
        "Recovery instruction: retry the original folder move once now because only stale tracked records were found. If the move is still blocked afterward, stop and explain that no live exact holder was proven.",
      blockedFolderPaths
    });
  }

  const contextExactPreviewLeaseIds = extractWorkspaceRecoveryExactPreviewLeaseIds(
    taskRunResult.task.userInput
  );
  const contextWorkspaceRoots = extractWorkspaceRecoveryContextRoots(
    taskRunResult.task.userInput
  );
  if (
    contextExactPreviewLeaseIds.length > 0 &&
    blockedFolderPaths.length > 0 &&
    contextWorkspaceRoots.length > 0 &&
    blockedFolderPaths.every((blockedFolderPath) =>
      contextWorkspaceRoots.some((rootPath) =>
        workspaceRecoveryPathsOverlap(rootPath, blockedFolderPath)
      )
    )
  ) {
    return buildStopExactTrackedRecoverySignal({
      matchedRuleId: "post_execution_exact_holder_folder_recovery_from_request_context",
      reasoning:
        "The blocked folders already map to exact tracked preview leases in the current recovery context, so the next safe recovery step is to stop only those exact holders and retry.",
      question:
        "I found the exact tracked preview holders already tied to those blocked folders, so I can shut down only those exact holders and retry the move now.",
      recoveryInstruction:
        `Recovery instruction: stop only these exact tracked preview holders if they are still active: ${contextExactPreviewLeaseIds.map((leaseId) => `leaseId="${leaseId}"`).join(", ")}. ` +
        "Verify they stopped, then retry the original folder-organization request. Do not stop unrelated apps by name.",
      trackedPreviewProcessLeaseIds: contextExactPreviewLeaseIds,
      blockedFolderPaths
    });
  }

  const blockedFolderPathClause =
    blockedFolderPaths.length > 0
      ? `Inspect these exact blocked folder paths first: ${blockedFolderPaths.join(", ")}. `
      : "";
  return buildInspectFirstRecoverySignal({
    matchedRuleId: "post_execution_locked_folder_recovery",
    reasoning:
      "The move is blocked because the target folders are still in use, so the next safe recovery step is to inspect holders first instead of guessing which process to stop.",
    question:
      "I couldn't move those folders yet because one or more are still open in a local preview process. I can inspect the matching holders, shut down only exact tracked ones, and retry the move. Do you want me to do that?",
    recoveryInstruction:
      "Recovery instruction: inspect the relevant workspace resources or path holders first. " +
      blockedFolderPathClause +
      "If exact tracked preview holders are found, stop only those exact tracked holders, confirm they stopped, then retry the original folder-organization request. " +
      "If the inspection finds only likely untracked holders, explain that user confirmation is required before shutting them down.",
    blockedFolderPaths
  });
}

/**
 * Derives one bounded recovery signal from an inspection-only workspace-recovery follow-up.
 *
 * @param taskRunResult - Completed task result being evaluated.
 * @returns Structured recovery signal, or `null` when this task is not an inspection-only recovery step.
 */
export function deriveWorkspaceRecoveryInspectionSignal(
  taskRunResult: TaskRunResult
): WorkspaceRecoverySignal | null {
  if (!isLocalOrganizationRecoveryContext(taskRunResult)) {
    return null;
  }
  if (!hasApprovedWorkspaceRecoveryInspectionAction(taskRunResult)) {
    return null;
  }
  if (
    hasApprovedWorkspaceRecoveryMoveAction(taskRunResult) ||
    hasApprovedWorkspaceRecoveryStopProcessAction(taskRunResult)
  ) {
    return null;
  }

  const inspectionMetadata = readRuntimeOwnershipInspectionMetadata(taskRunResult);
  if (!inspectionMetadata) {
    return null;
  }

  if (
    inspectionMetadata.recommendedNextAction === "stop_exact_tracked_holders" &&
    (
      inspectionMetadata.previewProcessLeaseIds.length > 0 ||
      inspectionMetadata.recoveredExactPreviewHolderPids.length > 0
    )
  ) {
    const leaseList = inspectionMetadata.previewProcessLeaseIds
      .map((leaseId) => `leaseId="${leaseId}"`)
      .join(", ");
    const recoveredPidList = inspectionMetadata.recoveredExactPreviewHolderPids
      .map((pid) => `pid=${pid}`)
      .join(", ");
    const stopTargetList = [leaseList, recoveredPidList].filter(Boolean).join(", ");
    return buildStopExactTrackedRecoverySignal({
      matchedRuleId: "inspection_only_exact_tracked_folder_recovery",
      reasoning:
        "The holder inspection proved exact preview holders, so the next safe recovery step is to stop only those holders and retry.",
      question:
        "I found the exact preview holders still blocking those folders. I can shut down only those exact holders and retry the move. Do you want me to do that?",
      recoveryInstruction:
        `Recovery instruction: stop only these exact preview holders if they are still active: ${stopTargetList}. ` +
        "Use exact tracked lease ids when available, or exact recovered preview-holder pids only when inspection proved them safely enough. " +
        "Verify they stopped, then retry the original folder-organization request. Do not stop unrelated apps by name.",
      trackedPreviewProcessLeaseIds: inspectionMetadata.previewProcessLeaseIds,
      recoveredExactHolderPids: inspectionMetadata.recoveredExactPreviewHolderPids
    });
  }

  if (
    inspectionMetadata.recommendedNextAction ===
      "clarify_before_exact_non_preview_shutdown" &&
    inspectionMetadata.ownershipClassification === "orphaned_attributable"
  ) {
    const exactNonPreviewHolders = selectExactNonPreviewHolderCandidates(
      inspectionMetadata.untrackedCandidates
    );
    if (exactNonPreviewHolders.length > 0) {
      const holderKindText = describeUntrackedHolderKinds([
        ...exactNonPreviewHolders.map(
          (exactNonPreviewHolder) =>
            exactNonPreviewHolder.kind ?? "unknown_local_process"
        )
      ]);
      const holderLabel = formatExactNonPreviewHolderLabels(exactNonPreviewHolders);
      const singleExactNonPreviewHolder =
        exactNonPreviewHolders.length === 1 ? exactNonPreviewHolders[0] : null;
      return buildExactNonPreviewClarificationSignal({
        matchedRuleId: "inspection_only_exact_non_preview_holder_recovery_clarification",
        reasoning:
          `Inspection found ${
            exactNonPreviewHolders.length > 1
              ? "multiple high-confidence non-preview local holders"
              : "one high-confidence non-preview local holder"
          } tied to the folders, so the next safe step is to ask before stopping only ${
            exactNonPreviewHolders.length > 1 ? "those exact processes" : "that exact process"
          }.`,
        question:
          `I found ${
            exactNonPreviewHolders.length > 1
              ? `${exactNonPreviewHolders.length} high-confidence local holders`
              : "one high-confidence local holder"
          } still tied to those folders: ${holderLabel}. It still looks like ${formatIndefiniteHolderProcessPhrase(holderKindText)} is holding them. If you want, I can stop just ${
            exactNonPreviewHolders.length > 1 ? "those exact processes" : "that process"
          } and retry the move. Do you want me to do that?`,
        recoveryInstruction: buildWorkspaceRecoveryExactNonPreviewShutdownInput(
          taskRunResult.task.userInput,
          exactNonPreviewHolders
        ),
        recoveredExactHolderPids: exactNonPreviewHolders.map((candidate) => candidate.pid),
        untrackedCandidatePids: exactNonPreviewHolders.map((candidate) => candidate.pid),
        exactNonPreviewHolders,
        exactNonPreviewHolderPid: singleExactNonPreviewHolder?.pid ?? null,
        exactNonPreviewHolderKind: singleExactNonPreviewHolder?.kind ?? null,
        exactNonPreviewHolderName: singleExactNonPreviewHolder?.name ?? null
      });
    }
  }

  if (inspectionMetadata.recommendedNextAction === "clarify_before_untracked_shutdown") {
    return buildPreviewClarificationSignal({
      matchedRuleId: "inspection_only_untracked_holder_recovery_clarification",
      reasoning:
        "The holder inspection found only likely untracked holders, so explicit user confirmation is still required before shutdown.",
      question:
        "I inspected the blocked folders and found only likely local holders, not exact tracked runtime resources. I need your confirmation before I shut any of those down.",
      recoveryInstruction:
        "Recovery instruction: do not stop likely untracked holders automatically. Explain that user confirmation is required before shutdown.",
      untrackedCandidatePids: inspectionMetadata.untrackedCandidatePids
    });
  }
  if (
    inspectionMetadata.recommendedNextAction ===
      "clarify_before_likely_non_preview_shutdown" &&
    inspectionMetadata.ownershipClassification === "orphaned_attributable"
  ) {
    const likelyHolderSetDescription = buildLikelyNonPreviewHolderSetDescription(
      inspectionMetadata.untrackedCandidateKinds,
      inspectionMetadata.untrackedCandidatePids.length
    );
    return buildWorkspaceRecoveryLikelyNonPreviewClarification({
      matchedRuleId: "inspection_only_likely_non_preview_holder_recovery_clarification",
      reasoning:
        `The holder inspection found ${likelyHolderSetDescription} tied to the folders, so the next safe step is to ask before stopping only that inspected set.`,
      leadIn:
        `I inspected the blocked folders and found ${likelyHolderSetDescription} still tied to them.`,
      candidatePids: inspectionMetadata.untrackedCandidatePids,
      candidateKinds: inspectionMetadata.untrackedCandidateKinds,
      candidateNames: inspectionMetadata.untrackedCandidateNames
    });
  }

  if (
    inspectionMetadata.recommendedNextAction === "manual_orphaned_browser_cleanup" &&
    inspectionMetadata.ownershipClassification === "orphaned_attributable"
  ) {
    return buildStopNoLiveHoldersSignal({
      matchedRuleId: "inspection_only_orphaned_browser_cleanup_required",
      reasoning:
        "Inspection found older assistant browser windows tied to the workspace, but the runtime no longer has direct control over them and did not prove a live shutdown-safe holder.",
      question:
        "I found older assistant browser windows still tied to that workspace, but I no longer have direct control over them. You may need to close those windows manually before I can continue safely.",
      recoveryInstruction:
        "Recovery instruction: stop and explain that earlier assistant browser windows are still attributable to the workspace, but the runtime no longer has direct control over them.",
    });
  }

  if (
    inspectionMetadata.recommendedNextAction === "manual_non_preview_holder_cleanup" &&
    inspectionMetadata.ownershipClassification === "orphaned_attributable"
  ) {
    const holderKindText = describeUntrackedHolderKinds(
      inspectionMetadata.untrackedCandidateKinds
    );
    const holderExamples = formatNamedHolderExamples(
      inspectionMetadata.untrackedCandidateNames
    );
    const manualCleanupGuidance = buildManualHolderReleaseGuidance(
      inspectionMetadata.untrackedCandidateKinds,
      inspectionMetadata.untrackedCandidateNames
    );
    const contextualManualCleanupSignal = buildContextualManualCleanupSignal({
      matchedRuleId: "inspection_only_contextual_non_preview_holder_cleanup_required",
      leadingQuestionClause: "I inspected the blocked folders and",
      untrackedCandidates: inspectionMetadata.untrackedCandidates,
      untrackedCandidatePids: inspectionMetadata.untrackedCandidatePids,
      untrackedCandidateKinds: inspectionMetadata.untrackedCandidateKinds,
      untrackedCandidateNames: inspectionMetadata.untrackedCandidateNames,
      manualCleanupGuidance
    });
    if (contextualManualCleanupSignal) {
      return contextualManualCleanupSignal;
    }
    return buildStopNoLiveHoldersSignal({
      matchedRuleId: "inspection_only_non_preview_holder_cleanup_required",
      reasoning:
        "Inspection found likely non-preview local holders tied to the folders, but no exact preview holder the runtime can shut down safely.",
      question:
        `I inspected the blocked folders and they still look busy in ${formatIndefiniteHolderProcessPhrase(holderKindText)}, not an exact tracked preview holder.${holderExamples} ` +
        `I should not shut that down automatically from this runtime evidence alone. ${manualCleanupGuidance}`,
      recoveryInstruction:
        "Recovery instruction: stop and explain that only likely non-preview local holders were found, so manual cleanup or a later retry is safer than automatic shutdown. " +
        `Recommend this next step instead: ${manualCleanupGuidance}`,
      untrackedCandidatePids: inspectionMetadata.untrackedCandidatePids
    });
  }

  if (inspectionMetadata.ownershipClassification === "stale_tracked") {
    return buildRetryAfterInspectionSignal({
      matchedRuleId: "inspection_only_stale_holder_records_only",
      reasoning:
        "Inspection found only stale tracked assistant resources, not a live holder that can be shut down safely, so the next safe step is one bounded retry of the move.",
      question:
        "I checked the old assistant resources tied to those folders, and they are already stale. I can retry the move once now in case the blocker already cleared.",
      recoveryInstruction:
        "Recovery instruction: retry the original folder move once now because only stale tracked records were found. If it is still blocked afterward, stop and explain that no live exact holder was proven.",
    });
  }

  return buildRetryAfterInspectionSignal({
    matchedRuleId: "inspection_only_retry_after_clean_inspection",
    reasoning:
      "The holder inspection did not prove a live exact holder, so the safest next step is to retry the move once in case the original lock has already cleared.",
    question:
      "I inspected the likely blockers and did not find a live exact holder I can shut down safely. I can retry the move once now in case the lock already cleared.",
    recoveryInstruction:
      "Recovery instruction: retry the original folder move once now, verify what moved, and stop with a clear blocker explanation if any folder is still locked afterward."
  });
}

/**
 * Builds the human-facing autonomous abort reason when only untracked holder candidates remain.
 *
 * @param signal - Structured workspace-recovery signal for the latest task result.
 * @returns Truthful abort reason explaining why confirmation is still required.
 */
export function buildWorkspaceRecoveryAbortReason(
  signal: WorkspaceRecoverySignal
): string {
  return buildWorkspaceRecoveryAbortReasonFromSignal(signal);
}

export {
  buildWorkspaceRecoveryNextUserInput,
  buildWorkspaceRecoveryPostInspectionRetryInput,
  buildWorkspaceRecoveryPostShutdownRetryInput,
  containsWorkspaceRecoveryInspectFirstMarker,
  containsWorkspaceRecoveryPostInspectionRetryMarker,
  containsWorkspaceRecoveryPostShutdownRetryMarker,
  containsWorkspaceRecoveryStopExactMarker
} from "./workspaceRecoveryCommandBuilders";
