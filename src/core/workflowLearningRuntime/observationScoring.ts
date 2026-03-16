/**
 * @fileoverview Deterministic workflow-observation scoring helpers derived from task receipts and action results.
 */

import type {
  ActionRunResult,
  TaskRunResult,
  WorkflowApprovalPosture,
  WorkflowCostBand,
  WorkflowExecutionStyle,
  WorkflowLatencyBand
} from "../types";

/**
 * Detects whether an action sequence touched the live-run process or browser proof path.
 *
 * @param actionTypes - Ordered action-type list from one task run.
 * @returns `true` when the sequence includes a live-run action.
 */
function hasLiveRunAction(actionTypes: readonly string[]): boolean {
  return actionTypes.some((type) =>
    [
      "start_process",
      "check_process",
      "stop_process",
      "probe_http",
      "probe_port",
      "verify_browser",
      "open_browser",
      "close_browser"
    ].includes(type)
  );
}

/**
 * Detects whether an action sequence created or reused a governed skill.
 *
 * @param actionTypes - Ordered action-type list from one task run.
 * @returns `true` when the sequence includes skill creation or skill reuse.
 */
function hasSkillAction(actionTypes: readonly string[]): boolean {
  return actionTypes.some((type) => type === "create_skill" || type === "run_skill");
}

/**
 * Derives a compact execution-style label from the action sequence.
 *
 * @param actionResults - Completed action results for the task run.
 * @returns Deterministic execution-style label.
 */
export function deriveWorkflowExecutionStyle(
  actionResults: readonly ActionRunResult[]
): WorkflowExecutionStyle {
  const actionTypes = actionResults.map((result) => result.action.type);
  if (actionTypes.length === 0 || actionTypes.every((type) => type === "respond")) {
    return "respond_only";
  }
  if (hasLiveRunAction(actionTypes)) {
    return "live_run";
  }
  if (hasSkillAction(actionTypes)) {
    return "skill_based";
  }
  if (actionTypes.length === 1) {
    return "single_action";
  }
  return "multi_action";
}

/**
 * Derives a stable action-sequence fingerprint for workflow observations.
 *
 * @param actionResults - Completed action results for the task run.
 * @returns Joined action sequence shape.
 */
export function deriveActionSequenceShape(actionResults: readonly ActionRunResult[]): string {
  return actionResults.map((result) => result.action.type).join(">");
}

/**
 * Derives the approval posture from completed action results.
 *
 * @param actionResults - Completed action results for the task run.
 * @returns Deterministic approval posture label.
 */
export function deriveWorkflowApprovalPosture(
  actionResults: readonly ActionRunResult[]
): WorkflowApprovalPosture {
  if (actionResults.length === 0) {
    return "none";
  }
  const approved = actionResults.filter((result) => result.approved);
  if (approved.length === 0) {
    return "blocked_only";
  }
  const hasFastPath = approved.some((result) => result.mode === "fast_path");
  const hasEscalation = approved.some((result) => result.mode === "escalation_path");
  if (hasFastPath && hasEscalation) {
    return "mixed";
  }
  if (hasEscalation) {
    return "escalation_only";
  }
  return "fast_path_only";
}

/**
 * Determines whether the run produced an explicit verification proof signal.
 *
 * @param actionResults - Completed action results for the task run.
 * @returns `true` when a verified browser or comparable proof signal was recorded.
 */
export function deriveVerificationProofPresence(
  actionResults: readonly ActionRunResult[]
): boolean {
  return actionResults.some((result) => {
    if (!result.approved) {
      return false;
    }
    if (result.action.type === "verify_browser" || result.executionMetadata?.browserVerifyPassed === true) {
      return true;
    }
    if (result.action.type === "probe_http" && result.executionStatus === "success") {
      return true;
    }
    return false;
  });
}

/**
 * Buckets total estimated run cost into a deterministic coarse band.
 *
 * @param actionResults - Completed action results for the task run.
 * @returns Cost band used for workflow comparisons.
 */
export function deriveWorkflowCostBand(
  actionResults: readonly ActionRunResult[]
): WorkflowCostBand {
  const totalEstimatedCost = actionResults.reduce(
    (sum, result) => sum + result.action.estimatedCostUsd,
    0
  );
  if (totalEstimatedCost <= 0) {
    return "none";
  }
  if (totalEstimatedCost < 0.1) {
    return "low";
  }
  if (totalEstimatedCost < 0.5) {
    return "medium";
  }
  return "high";
}

/**
 * Buckets end-to-end run latency into a deterministic coarse band.
 *
 * @param runResult - Completed task run result.
 * @returns Latency band used for workflow comparisons.
 */
export function deriveWorkflowLatencyBand(
  runResult: TaskRunResult
): WorkflowLatencyBand {
  const elapsedMs = Math.max(
    0,
    Date.parse(runResult.completedAt) - Date.parse(runResult.startedAt)
  );
  if (elapsedMs < 5_000) {
    return "fast";
  }
  if (elapsedMs < 30_000) {
    return "moderate";
  }
  return "slow";
}

/**
 * Derives the dominant failure mode from explicit taxonomy or the first blocked/execution failure signal.
 *
 * @param runResult - Completed task run result.
 * @returns Failure mode label or `null` when the run had no dominant failure signal.
 */
export function deriveDominantFailureMode(runResult: TaskRunResult): string | null {
  if (runResult.failureTaxonomy?.failureCategory) {
    return runResult.failureTaxonomy.failureCategory;
  }
  const failedAction = runResult.actionResults.find((result) => !result.approved || result.executionStatus === "failed");
  if (!failedAction) {
    return null;
  }
  if (failedAction.executionFailureCode) {
    return failedAction.executionFailureCode;
  }
  if (failedAction.blockedBy.length > 0) {
    return failedAction.blockedBy[0] ?? null;
  }
  if (failedAction.violations.length > 0) {
    return failedAction.violations[0]?.code ?? null;
  }
  return null;
}

/**
 * Derives the dominant recovery path from approved action shapes.
 *
 * @param actionResults - Completed action results for the task run.
 * @returns Recovery-path label or `null` when no recovery motif is evident.
 */
export function deriveRecoveryPath(actionResults: readonly ActionRunResult[]): string | null {
  const actionTypes = actionResults.map((result) => result.action.type);
  if (actionTypes.includes("check_process") && (actionTypes.includes("probe_http") || actionTypes.includes("probe_port"))) {
    return "live_run_readiness_recovery";
  }
  if (actionTypes.includes("verify_browser") && actionTypes.includes("probe_http")) {
    return "browser_verification_recovery";
  }
  if (actionTypes.includes("run_skill")) {
    return "skill_reuse";
  }
  return null;
}

/**
 * Reads linked skill information from receipt metadata when available.
 *
 * @param actionResults - Completed action results for the task run.
 * @returns Linked skill name plus verification status, or nulls when no skill metadata exists.
 */
export function deriveLinkedSkillMetadata(actionResults: readonly ActionRunResult[]): {
  linkedSkillName: string | null;
  linkedSkillVerificationStatus: "unverified" | "verified" | "failed" | null;
} {
  const skillResult = [...actionResults]
    .reverse()
    .find((result) => typeof result.executionMetadata?.skillName === "string");
  return {
    linkedSkillName: typeof skillResult?.executionMetadata?.skillName === "string"
      ? skillResult.executionMetadata.skillName
      : null,
    linkedSkillVerificationStatus:
      skillResult?.executionMetadata?.skillVerificationStatus === "verified" ||
      skillResult?.executionMetadata?.skillVerificationStatus === "failed" ||
      skillResult?.executionMetadata?.skillVerificationStatus === "unverified"
        ? skillResult.executionMetadata.skillVerificationStatus
        : null
  };
}
