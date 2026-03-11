/**
 * @fileoverview Deterministic workflow-observation extraction from completed task runs.
 */

import { extractActiveRequestSegment } from "../currentRequestExtraction";
import type { TaskRunResult, WorkflowObservation } from "../types";
import {
  deriveActionSequenceShape,
  deriveDominantFailureMode,
  deriveLinkedSkillMetadata,
  deriveRecoveryPath,
  deriveVerificationProofPresence,
  deriveWorkflowApprovalPosture,
  deriveWorkflowCostBand,
  deriveWorkflowExecutionStyle,
  deriveWorkflowLatencyBand
} from "./observationScoring";

/**
 * Extracts stable context tags from the active user request for workflow grouping.
 *
 * @param activeRequest - Active request segment extracted from one task run.
 * @returns Deduplicated low-noise context tags.
 */
function deriveContextTagsFromRequest(activeRequest: string): string[] {
  return [...new Set(
    activeRequest
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length >= 4)
      .slice(0, 8)
  )];
}

/**
 * Builds the canonical workflow key used for workflow-pattern persistence and lookup.
 *
 * @param runResult - Completed task run.
 * @param activeRequest - Active request segment extracted from the run input.
 * @returns Deterministic workflow key.
 */
function deriveWorkflowKey(runResult: TaskRunResult, activeRequest: string): string {
  const actionPrefix = runResult.plan.actions.map((action) => action.type).join("+");
  const requestFingerprint = activeRequest
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 4)
    .slice(0, 5)
    .join("_");
  return `${actionPrefix}:${requestFingerprint || "general"}`;
}

/**
 * Resolves the workflow outcome class from approved versus blocked action results.
 *
 * @param runResult - Completed task run.
 * @returns Workflow outcome label.
 */
function deriveWorkflowOutcome(runResult: TaskRunResult): WorkflowObservation["outcome"] {
  const blockedCount = runResult.actionResults.filter((result) => !result.approved).length;
  const approvedCount = runResult.actionResults.filter((result) => result.approved).length;
  if (approvedCount > 0 && blockedCount === 0) {
    return "success";
  }
  if (approvedCount === 0 && blockedCount > 0) {
    return "suppressed";
  }
  return "failure";
}

/**
 * Derives a richer deterministic workflow observation from a completed run.
 *
 * @param runResult - Completed task run result.
 * @returns Structured workflow observation ready for persistence.
 */
export function deriveWorkflowObservationFromTaskRunDetailed(
  runResult: TaskRunResult
): WorkflowObservation {
  const activeRequest = extractActiveRequestSegment(runResult.task.userInput).trim();
  const workflowKey = deriveWorkflowKey(runResult, activeRequest);
  const { linkedSkillName, linkedSkillVerificationStatus } = deriveLinkedSkillMetadata(
    runResult.actionResults
  );
  return {
    workflowKey,
    outcome: deriveWorkflowOutcome(runResult),
    observedAt: runResult.completedAt,
    domainLane: "workflow",
    contextTags: deriveContextTagsFromRequest(activeRequest),
    executionStyle: deriveWorkflowExecutionStyle(runResult.actionResults),
    actionSequenceShape: deriveActionSequenceShape(runResult.actionResults),
    approvalPosture: deriveWorkflowApprovalPosture(runResult.actionResults),
    verificationProofPresent: deriveVerificationProofPresence(runResult.actionResults),
    costBand: deriveWorkflowCostBand(runResult.actionResults),
    latencyBand: deriveWorkflowLatencyBand(runResult),
    dominantFailureMode: deriveDominantFailureMode(runResult),
    recoveryPath: deriveRecoveryPath(runResult.actionResults),
    linkedSkillName,
    linkedSkillVerificationStatus
  };
}
