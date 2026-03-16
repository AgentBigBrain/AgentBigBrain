/**
 * @fileoverview Marker-bearing recovery command builders for bounded workspace-lock retries.
 */

import type { WorkspaceRecoverySignal } from "./workspaceRecoveryPolicy";
import { formatBlockedFolderPaths } from "./workspaceRecoveryNarration";
import { buildWorkspaceRecoveryExactNonPreviewShutdownInput } from "./workspaceRecoveryExactNonPreviewSupport";

const WORKSPACE_RECOVERY_INSPECT_FIRST_MARKER = "[WORKSPACE_RECOVERY_INSPECT_FIRST]";
const WORKSPACE_RECOVERY_STOP_EXACT_MARKER = "[WORKSPACE_RECOVERY_STOP_EXACT]";
const WORKSPACE_RECOVERY_POST_SHUTDOWN_RETRY_MARKER =
  "[WORKSPACE_RECOVERY_POST_SHUTDOWN_RETRY]";
const WORKSPACE_RECOVERY_POST_INSPECTION_RETRY_MARKER =
  "[WORKSPACE_RECOVERY_POST_INSPECTION_RETRY]";

/**
 * Detects whether the execution input is the autonomous inspect-first recovery step for a blocked
 * local organization request.
 *
 * @param userInput - Planner-facing execution input.
 * @returns `true` when the inspect-first recovery marker is present.
 */
export function containsWorkspaceRecoveryInspectFirstMarker(userInput: string): boolean {
  return userInput.includes(WORKSPACE_RECOVERY_INSPECT_FIRST_MARKER);
}

/**
 * Detects whether the execution input is the autonomous exact-holder shutdown recovery step.
 *
 * @param userInput - Planner-facing execution input.
 * @returns `true` when the exact-stop recovery marker is present.
 */
export function containsWorkspaceRecoveryStopExactMarker(userInput: string): boolean {
  return userInput.includes(WORKSPACE_RECOVERY_STOP_EXACT_MARKER);
}

/**
 * Detects whether the execution input is the bounded post-shutdown move retry step.
 *
 * @param userInput - Planner-facing execution input.
 * @returns `true` when the post-shutdown retry marker is present.
 */
export function containsWorkspaceRecoveryPostShutdownRetryMarker(
  userInput: string
): boolean {
  return userInput.includes(WORKSPACE_RECOVERY_POST_SHUTDOWN_RETRY_MARKER);
}

/**
 * Detects whether the execution input is the bounded post-inspection move retry step.
 *
 * @param userInput - Planner-facing execution input.
 * @returns `true` when the post-inspection retry marker is present.
 */
export function containsWorkspaceRecoveryPostInspectionRetryMarker(
  userInput: string
): boolean {
  return userInput.includes(WORKSPACE_RECOVERY_POST_INSPECTION_RETRY_MARKER);
}

/**
 * Builds the deterministic next subtask input for autonomous workspace-lock recovery.
 *
 * @param overarchingGoal - Original autonomous goal being continued.
 * @param signal - Structured workspace-recovery signal for the latest task result.
 * @returns Explicit next-step instruction for the autonomous loop.
 */
export function buildWorkspaceRecoveryNextUserInput(
  overarchingGoal: string,
  signal: WorkspaceRecoverySignal
): string {
  if (signal.recommendedAction === "retry_after_inspection") {
    return buildWorkspaceRecoveryPostInspectionRetryInput(overarchingGoal);
  }
  if (signal.recommendedAction === "clarify_before_exact_non_preview_shutdown") {
    const exactNonPreviewHolders =
      signal.exactNonPreviewHolders && signal.exactNonPreviewHolders.length > 0
        ? signal.exactNonPreviewHolders
        : typeof signal.exactNonPreviewHolderPid === "number"
          ? [
              {
                pid: signal.exactNonPreviewHolderPid,
                kind: signal.exactNonPreviewHolderKind,
                name: signal.exactNonPreviewHolderName
              }
            ]
          : [];
    if (exactNonPreviewHolders.length > 0) {
      return buildWorkspaceRecoveryExactNonPreviewShutdownInput(
        overarchingGoal,
        exactNonPreviewHolders
      );
    }
  }
  const blockedFolderPaths = signal.blockedFolderPaths ?? [];
  if (signal.recommendedAction === "stop_exact_tracked_holders") {
    const leaseList = signal.trackedPreviewProcessLeaseIds
      .map((leaseId) => `leaseId="${leaseId}"`)
      .join(", ");
    const recoveredPidList = signal.recoveredExactHolderPids
      .map((pid) => `pid=${pid}`)
      .join(", ");
    const exactHolderTargets = [leaseList, recoveredPidList].filter(Boolean).join(", ");
    return [
      WORKSPACE_RECOVERY_STOP_EXACT_MARKER,
      "A folder move was blocked because exact tracked preview holders are still using the target folders. " +
        `Stop only these exact preview holders if they are still active: ${exactHolderTargets}. ` +
        `Verify they stopped, then retry this original folder-organization goal: "${overarchingGoal}". ` +
        "Do not stop unrelated apps by name. If those exact tracked holders are already gone, inspect the path holders once and explain the remaining blocker plainly instead of claiming the move worked."
    ].join("\n");
  }

  return [
    WORKSPACE_RECOVERY_INSPECT_FIRST_MARKER,
    "A folder move was blocked because the target folders are still in use.",
    "Use inspect_workspace_resources or inspect_path_holders as the main non-respond action for this step; list_directory alone is not enough.",
    ...formatBlockedFolderPaths(blockedFolderPaths),
    "Inspect the relevant workspace resources or path holders first. " +
      "If exact tracked preview holders are found, stop only those exact tracked holders and retry this original folder-organization goal: " +
      `"${overarchingGoal}". ` +
      "If the inspection finds only likely untracked holders, stop and explain that user confirmation is required before shutting them down. " +
      "Do not stop unrelated apps by name."
  ].join("\n");
}

/**
 * Builds the bounded post-shutdown retry input after an exact tracked holder stop already
 * succeeded in the autonomous loop.
 *
 * @param overarchingGoal - Original autonomous goal being continued.
 * @returns Explicit retry instruction for the original folder-organization goal.
 */
export function buildWorkspaceRecoveryPostShutdownRetryInput(
  overarchingGoal: string
): string {
  return [
    WORKSPACE_RECOVERY_POST_SHUTDOWN_RETRY_MARKER,
    `Retry this original folder-organization goal now: "${overarchingGoal}". ` +
      "Verify which matching folders moved into the destination and which, if any, still remain outside it. " +
      "Do not stop unrelated apps by name. If any remaining folder is still blocked, inspect holders first instead of guessing."
  ].join("\n");
}

/**
 * Builds the bounded post-inspection retry input when inspection did not prove a holder but the
 * runtime should retry the original move once in case the lock already cleared.
 *
 * @param overarchingGoal - Original autonomous goal being continued.
 * @returns Explicit retry instruction for the original folder-organization goal.
 */
export function buildWorkspaceRecoveryPostInspectionRetryInput(
  overarchingGoal: string
): string {
  return [
    WORKSPACE_RECOVERY_POST_INSPECTION_RETRY_MARKER,
    `Retry this original folder-organization goal now: "${overarchingGoal}". ` +
      "The last holder inspection did not prove a live exact holder, so retry the actual move once in case the lock already cleared. " +
      "Verify which matching folders moved into the destination and which, if any, still remain outside it. " +
      "If any remaining folder is still blocked after this retry, stop and explain that no exact holder was proven safely enough for automatic shutdown."
  ].join("\n");
}
