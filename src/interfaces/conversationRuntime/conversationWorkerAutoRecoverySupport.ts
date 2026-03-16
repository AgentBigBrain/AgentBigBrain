/**
 * @fileoverview Shared helper utilities for bounded tracked-workspace auto-recovery.
 */

import { extractActiveRequestSegment } from "../../core/currentRequestExtraction";
import {
  buildWorkspaceRecoveryNextUserInput,
  buildWorkspaceRecoveryPostShutdownRetryInput
} from "../../core/autonomy/workspaceRecoveryCommandBuilders";
import type { WorkspaceRecoverySignal } from "../../core/autonomy/workspaceRecoveryPolicy";
import type { TaskRunResult } from "../../core/types";
import type { ConversationJob, ConversationSession } from "../sessionStore";

const AUTOMATIC_TRACKED_WORKSPACE_RECOVERY_MARKER =
  "[AUTOMATIC_TRACKED_WORKSPACE_RECOVERY]";
const AUTOMATIC_TRACKED_WORKSPACE_INSPECT_FIRST_MARKER =
  "[AUTOMATIC_TRACKED_WORKSPACE_INSPECT_FIRST]";
const AUTOMATIC_TRACKED_WORKSPACE_POST_SHUTDOWN_RETRY_MARKER =
  "[AUTOMATIC_TRACKED_WORKSPACE_POST_SHUTDOWN_RETRY]";
const LOCAL_ORGANIZATION_VERB_PATTERN =
  /\b(?:organize|move|group|gather|sort|clean up|put|collect|tidy)\b/i;
const LOCAL_ORGANIZATION_TARGET_PATTERN =
  /\b(?:folder|folders|directory|directories|desktop|documents|downloads|workspace|workspaces|project|projects)\b/i;
const LOCAL_ORGANIZATION_MOVE_COMMAND_PATTERN = /\b(?:move-item|mv|move)\b/i;

/**
 * Normalizes a filesystem path into a stable comparison form.
 *
 * @param value - Candidate filesystem path.
 * @returns Normalized path, or `null` when absent.
 */
function normalizeComparablePath(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Returns whether two filesystem targets overlap by direct equality or containment.
 *
 * @param left - First path candidate.
 * @param right - Second path candidate.
 * @returns `true` when the paths overlap.
 */
export function pathsOverlap(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  const normalizedLeft = normalizeComparablePath(left);
  const normalizedRight = normalizeComparablePath(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  if (normalizedLeft === normalizedRight) {
    return true;
  }
  const separatorPattern = /[\\/]/;
  return (
    normalizedLeft.startsWith(`${normalizedRight}\\`) ||
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}\\`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`) ||
    (
      separatorPattern.test(normalizedLeft) &&
      separatorPattern.test(normalizedRight) &&
      (
        normalizedLeft.startsWith(`${normalizedRight}${process.platform === "win32" ? "\\" : "/"}`) ||
        normalizedRight.startsWith(`${normalizedLeft}${process.platform === "win32" ? "\\" : "/"}`)
      )
    )
  );
}

/**
 * Deduplicates non-empty strings while preserving first-seen order.
 *
 * @param values - Candidate string values.
 * @returns Unique non-empty strings.
 */
export function uniqueNonEmpty(values: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

/**
 * Detects whether a queued job already represents one automatic exact-tracked workspace recovery retry.
 *
 * @param job - Queued or completed conversation job being evaluated.
 * @returns `true` when the execution input already carries the automatic tracked-recovery marker.
 */
export function hasAutomaticTrackedWorkspaceRecoveryMarker(job: ConversationJob): boolean {
  const executionInput = job.executionInput ?? "";
  return executionInput.includes(AUTOMATIC_TRACKED_WORKSPACE_RECOVERY_MARKER);
}

/**
 * Detects whether a queued job already represents one automatic inspect-first recovery step.
 *
 * @param job - Queued or completed conversation job being evaluated.
 * @returns `true` when the execution input already carries the automatic inspect-first marker.
 */
export function hasAutomaticTrackedWorkspaceInspectFirstMarker(
  job: ConversationJob
): boolean {
  const executionInput = job.executionInput ?? "";
  return executionInput.includes(AUTOMATIC_TRACKED_WORKSPACE_INSPECT_FIRST_MARKER);
}

/**
 * Detects whether a queued job already represents one automatic post-shutdown organization retry.
 *
 * @param job - Queued or completed conversation job being evaluated.
 * @returns `true` when the execution input already carries the bounded post-shutdown marker.
 */
export function hasAutomaticTrackedWorkspacePostShutdownRetryMarker(
  job: ConversationJob
): boolean {
  const executionInput = job.executionInput ?? "";
  return executionInput.includes(AUTOMATIC_TRACKED_WORKSPACE_POST_SHUTDOWN_RETRY_MARKER);
}

/**
 * Builds the bounded retry execution input for one automatic exact-tracked workspace recovery pass.
 *
 * @param sourceInput - Original user request that should be retried.
 * @param recoverySignal - Deterministic recovery signal derived from exact holder evidence.
 * @returns Internal execution input for the automatic retry job.
 */
export function buildAutomaticTrackedWorkspaceRecoveryExecutionInput(
  sourceInput: string,
  recoverySignal: WorkspaceRecoverySignal
): string {
  const activeRequest = extractActiveRequestSegment(sourceInput).trim();
  const recoveryExecutionInput = buildWorkspaceRecoveryNextUserInput(
    activeRequest || sourceInput.trim(),
    recoverySignal
  );
  return [
    sourceInput,
    "",
    AUTOMATIC_TRACKED_WORKSPACE_RECOVERY_MARKER,
    recoveryExecutionInput
  ].join("\n");
}

/**
 * Builds the bounded inspect-first execution input for one automatic exact-tracked workspace
 * recovery pass.
 *
 * @param sourceInput - Original user request that should be retried safely.
 * @param recoverySignal - Deterministic recovery signal derived from the blocked move.
 * @returns Internal execution input for the automatic inspect-first retry job.
 */
export function buildAutomaticTrackedWorkspaceInspectFirstExecutionInput(
  sourceInput: string,
  recoverySignal: WorkspaceRecoverySignal
): string {
  const activeRequest = extractActiveRequestSegment(sourceInput).trim();
  const recoveryExecutionInput = buildWorkspaceRecoveryNextUserInput(
    activeRequest || sourceInput.trim(),
    recoverySignal
  );
  return [
    sourceInput,
    "",
    AUTOMATIC_TRACKED_WORKSPACE_INSPECT_FIRST_MARKER,
    recoveryExecutionInput
  ].join("\n");
}

/**
 * Builds one bounded retry execution input after an exact tracked-holder shutdown already happened.
 *
 * @param sourceInput - Original organization request that should now be retried cleanly.
 * @returns Internal execution input for one post-shutdown retry pass.
 */
export function buildAutomaticTrackedWorkspacePostShutdownRetryExecutionInput(
  sourceInput: string
): string {
  const activeRequest = extractActiveRequestSegment(sourceInput).trim();
  return [
    sourceInput,
    "",
    AUTOMATIC_TRACKED_WORKSPACE_POST_SHUTDOWN_RETRY_MARKER,
    buildWorkspaceRecoveryPostShutdownRetryInput(activeRequest || sourceInput.trim())
  ].join("\n");
}

/**
 * Builds the user-facing note shown when the worker can safely retry with exact tracked holder evidence.
 *
 * @returns Human-readable retry notice.
 */
export function buildAutomaticTrackedWorkspaceRecoveryNotice(): string {
  return (
    "I found the exact tracked preview holders blocking those folders. " +
    "I'm shutting down just those tracked holders and retrying now."
  );
}

/**
 * Builds the user-facing note shown when the worker can safely inspect exact holder evidence
 * before asking the human anything.
 *
 * @returns Human-readable inspect-first notice.
 */
export function buildAutomaticTrackedWorkspaceInspectFirstNotice(): string {
  return (
    "Those folders still look busy. I'm inspecting the matching holders now so I can keep the " +
    "recovery narrow and avoid touching unrelated local tools."
  );
}

/**
 * Builds the user-facing note shown when exact tracked holder shutdown already succeeded and the
 * runtime is retrying the original organization move itself.
 *
 * @returns Human-readable retry notice.
 */
export function buildAutomaticTrackedWorkspacePostShutdownRetryNotice(): string {
  return (
    "I shut down the exact tracked preview holders that were blocking those folders. " +
    "I'm retrying the move now and will verify the destination before I finish."
  );
}

/**
 * Returns `true` when the active request is a local folder-organization goal.
 *
 * @param userInput - Original user wording or wrapped execution input.
 * @returns `true` when the request is a local organization task.
 */
export function isLocalOrganizationRequest(userInput: string): boolean {
  const activeRequest = extractActiveRequestSegment(userInput);
  return (
    LOCAL_ORGANIZATION_VERB_PATTERN.test(activeRequest) &&
    LOCAL_ORGANIZATION_TARGET_PATTERN.test(activeRequest)
  );
}

/**
 * Returns `true` when the run already executed a real folder-move shell command.
 *
 * @param taskRunResult - Completed task result being evaluated.
 * @returns `true` when a real move step already ran.
 */
export function hasApprovedOrganizationMoveShellAction(
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
 * Returns `true` when the run already shut down one exact tracked preview holder.
 *
 * @param taskRunResult - Completed task result being evaluated.
 * @returns `true` when a holder shutdown step already ran.
 */
export function hasApprovedStopProcessAction(taskRunResult: TaskRunResult): boolean {
  return taskRunResult.actionResults.some(
    (result) => result.approved && result.action.type === "stop_process"
  );
}

/**
 * Replaces the most recent assistant turn when worker persistence already recorded a generic summary.
 *
 * @param session - Mutable conversation session whose turn history should stay aligned.
 * @param previousText - Previous assistant text emitted for the just-completed job.
 * @param nextText - Replacement assistant text that should represent the final delivered summary.
 */
export function replaceLatestAssistantTurnText(
  session: ConversationSession,
  previousText: string | null,
  nextText: string
): void {
  if (!previousText) {
    return;
  }
  for (let index = session.conversationTurns.length - 1; index >= 0; index -= 1) {
    const turn = session.conversationTurns[index];
    if (turn?.role !== "assistant") {
      continue;
    }
    if (turn.text !== previousText) {
      break;
    }
    turn.text = nextText;
    return;
  }
}

/**
 * Returns whether the completed job already persisted a recovery clarification or waiting handoff.
 *
 * @param session - Mutable conversation session being evaluated after job persistence.
 * @param completedJob - Completed job whose recovery path is being considered.
 * @returns `true` when the session already reached a waiting-for-user recovery stop for this job.
 */
export function hasWaitingForUserRecoveryStop(
  session: ConversationSession,
  completedJob: ConversationJob
): boolean {
  const trimmedSourceInput = completedJob.input.trim();
  const activeRecoveryClarification =
    session.activeClarification?.kind === "task_recovery" &&
    session.activeClarification.sourceInput.trim() === trimmedSourceInput;
  const waitingProgress = session.progressState?.status === "waiting_for_user";
  const waitingReturnHandoff =
    session.returnHandoff?.status === "waiting_for_user" &&
    session.returnHandoff.sourceJobId === completedJob.id;
  return activeRecoveryClarification || waitingProgress || waitingReturnHandoff;
}

/**
 * Returns `true` when a completed organization recovery pass already shut down exact tracked
 * holders but still needs one bounded retry of the original move.
 *
 * @param completedJob - Persisted completed conversation job.
 * @param taskRunResult - Completed task result used to derive recovery evidence.
 * @returns `true` when one bounded post-shutdown retry should be queued.
 */
export function shouldEnqueuePostShutdownOrganizationRetry(
  completedJob: ConversationJob,
  taskRunResult: TaskRunResult
): boolean {
  if (hasAutomaticTrackedWorkspacePostShutdownRetryMarker(completedJob)) {
    return false;
  }
  if (!isLocalOrganizationRequest(taskRunResult.task.userInput)) {
    return false;
  }
  if (!hasApprovedStopProcessAction(taskRunResult)) {
    return false;
  }
  if (hasApprovedOrganizationMoveShellAction(taskRunResult)) {
    return false;
  }
  return true;
}
