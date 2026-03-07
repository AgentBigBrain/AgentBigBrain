/**
 * @fileoverview Debug and diagnostics rendering helpers for user-facing run summaries.
 */

import { MissionTimelineV1, TaskRunResult } from "../../core/types";
import {
  buildMissionUxResultEnvelope,
  deriveMissionUxState,
  determineApprovalGranularity,
  formatStableApprovalDiff
} from "../../core/stage6_85MissionUxPolicy";
import { evaluateVerificationGate } from "../../core/stage6_85QualityGatePolicy";
import {
  buildMissionTimelineV1,
  explainFailureDeterministically
} from "../../core/stage6_85ObservabilityPolicy";
import {
  containsApprovalFlowPrompt,
  containsMissionDiagnosticPrompt,
  resolveVerificationCategoryForPrompt,
  shouldEvaluateVerificationGateForDiagnostics
} from "../diagnosticsPromptPolicy";
import { extractBlockedPolicyCodes } from "./blockSurface";
import {
  NormalizedUserFacingSummaryOptions,
  applyTruthPolicyV1ToOutcomeSummary
} from "./contracts";

/**
 * Derives stage685 tier from action type for approval diagnostics.
 */
function deriveStage685TierFromActionType(actionType: string): number | null {
  if (actionType === "respond") {
    return 0;
  }
  if (
    actionType === "read_file" ||
    actionType === "list_directory" ||
    actionType === "check_process" ||
    actionType === "probe_port" ||
    actionType === "probe_http" ||
    actionType === "verify_browser"
  ) {
    return 1;
  }
  if (
    actionType === "write_file" ||
    actionType === "delete_file" ||
    actionType === "create_skill" ||
    actionType === "run_skill" ||
    actionType === "network_write" ||
    actionType === "shell_command" ||
    actionType === "start_process" ||
    actionType === "stop_process" ||
    actionType === "self_modify"
  ) {
    return 3;
  }
  return null;
}

/**
 * Formats action types as a deterministic, deduplicated display list.
 */
function formatUniqueActionTypeList(actionTypes: readonly string[]): string {
  const uniqueSorted = Array.from(new Set(actionTypes.filter((value) => value.trim().length > 0))).sort(
    (left, right) => left.localeCompare(right)
  );
  return uniqueSorted.length > 0 ? uniqueSorted.join(", ") : "none";
}

/**
 * Returns true when the plan contains only respond actions.
 */
function isRespondOnlyPlan(runResult: TaskRunResult): boolean {
  if (runResult.plan.actions.length === 0) {
    return false;
  }
  return runResult.plan.actions.every((action) => action.type === "respond");
}

/**
 * Builds a mission timeline view from the run result.
 */
function buildMissionTimelineFromRunResult(runResult: TaskRunResult): MissionTimelineV1 {
  const truthSafeSummary = applyTruthPolicyV1ToOutcomeSummary(runResult.summary, runResult);
  const events: Array<MissionTimelineV1["events"][number]> = [];
  let sequence = 1;
  events.push({
    sequence,
    phase: "planning",
    eventType: "plan",
    detail: `Planned ${runResult.plan.actions.length} action(s).`,
    observedAt: runResult.startedAt
  });
  sequence += 1;

  for (const result of runResult.actionResults) {
    events.push({
      sequence,
      phase: "executing",
      eventType: "action",
      detail: `${result.action.type} (${result.approved ? "approved" : "blocked"})`,
      observedAt: runResult.completedAt
    });
    sequence += 1;
  }

  events.push({
    sequence,
    phase: "completed",
    eventType: "outcome",
    detail: truthSafeSummary,
    observedAt: runResult.completedAt
  });

  return buildMissionTimelineV1({
    missionId: runResult.task.id,
    events
  });
}

/**
 * Builds the user-facing diagnostics block used for status and review prompts.
 */
export function buildMissionDiagnosticsBlock(runResult: TaskRunResult): string {
  const truthSafeSummary = applyTruthPolicyV1ToOutcomeSummary(runResult.summary, runResult);
  const blockedPolicyCodes = extractBlockedPolicyCodes(runResult);
  const respondOnlyPlan = isRespondOnlyPlan(runResult);
  const approvalFlowPrompt = containsApprovalFlowPrompt(runResult.task.userInput);
  const state = deriveMissionUxState({
    hasCompletedOutcome: runResult.actionResults.some((result) => result.approved),
    hasBlockingOutcome: runResult.actionResults.some((result) => !result.approved),
    awaitingApproval: false,
    hasInFlightExecution: false
  });

  const tierDerivation = runResult.plan.actions.map((action) =>
    deriveStage685TierFromActionType(action.type)
  );
  const tierDerivationFailed = tierDerivation.some((value) => value === null);
  const approvalDecision = determineApprovalGranularity({
    stepTiers: tierDerivation.filter((value): value is number => value !== null),
    playbookAllowlistedForApproveAll: false,
    tierDerivationFailed
  });

  const shouldEvaluateVerificationGate = shouldEvaluateVerificationGateForDiagnostics(runResult);
  const verificationGate = shouldEvaluateVerificationGate
    ? evaluateVerificationGate({
      gateId: "verification_gate_runtime_chat",
      category: resolveVerificationCategoryForPrompt(runResult.task.userInput),
      proofRefs: runResult.actionResults
        .filter((result) => result.approved && result.action.type !== "respond")
        .map((result) => `action:${result.action.id}`),
      waiverApproved: false
    })
    : null;

  const missionEnvelope = buildMissionUxResultEnvelope({
    missionId: runResult.task.id,
    state,
    summary: truthSafeSummary,
    evidenceRefs: blockedPolicyCodes.map((code) => `policy:${code}`),
    receiptRefs: runResult.actionResults
      .filter((result) => result.approved)
      .map((result) => `action:${result.action.id}`),
    nextStepSuggestion:
      state === "blocked"
        ? "Resolve block reason or approval requirement, then retry."
        : state === "completed"
          ? "Proceed to next governed step if needed."
          : "Review pending mission state and continue."
  });

  const timeline = buildMissionTimelineFromRunResult(runResult);
  const timelinePreview = timeline.events
    .slice(0, 5)
    .map((event) => `${String(event.sequence).padStart(2, "0")} ${event.eventType}:${event.detail}`)
    .join(" | ");

  const plannedActions = formatUniqueActionTypeList(
    runResult.plan.actions.map((action) => action.type)
  );
  const executedActions = formatUniqueActionTypeList(
    runResult.actionResults
      .filter((result) => result.approved)
      .map((result) => result.action.type)
  );
  const blockedReason = blockedPolicyCodes.length > 0 ? blockedPolicyCodes.join(", ") : "none";
  const stableApprovalDiff = respondOnlyPlan
    ? "none (respond-only plan in this run; no side-effect diff to approve)."
    : formatStableApprovalDiff(
      runResult.plan.actions.map((action) => `${action.type}: ${action.description}`)
    );
  const approvalModeLine = respondOnlyPlan
    ? "not_applicable (respond-only plan; no side-effect approval scope in this run.)"
    : `${approvalDecision.approvalMode} (${approvalDecision.reason})`;

  let deterministicRemediation = "No deterministic remediation required.";
  if (blockedPolicyCodes.includes("WORKFLOW_DRIFT_DETECTED")) {
    const explained = explainFailureDeterministically({
      blockCode: "WORKFLOW_DRIFT_DETECTED",
      conflictCode: null
    });
    deterministicRemediation = `${explained.summary} ${explained.remediation.join(" ")}`.trim();
  } else if (blockedPolicyCodes.length > 0) {
    deterministicRemediation = "Address the typed block reason and rerun through governed approval.";
  } else if (respondOnlyPlan && approvalFlowPrompt) {
    deterministicRemediation =
      "No side-effect action was planned in this run. Request a governed side-effect action to enter approval diff flow.";
  }

  return [
    "Run summary:",
    `- State: ${missionEnvelope.state}`,
    `- What will run: ${plannedActions}`,
    `- What ran: ${executedActions}`,
    `- Why stopped/blocked: ${blockedReason}`,
    `- Approval mode: ${approvalModeLine}`,
    shouldEvaluateVerificationGate
      ? `- Verification gate: ${verificationGate?.passed ? "passed" : "failed"} (${verificationGate?.reason ?? "n/a"})`
      : "- Verification gate: not_applicable (completion-claim gate not requested for this prompt)",
    `- Timeline: ${timelinePreview}`,
    "- Approval diff:",
    stableApprovalDiff,
    `- Deterministic remediation: ${deterministicRemediation}`
  ].join("\n");
}

/**
 * Appends mission diagnostics when the user explicitly asks for technical mission status.
 */
export function appendMissionDiagnosticsIfRequested(
  runResult: TaskRunResult,
  selectedSummary: string,
  options: NormalizedUserFacingSummaryOptions
): string {
  if (!options.showTechnicalSummary) {
    return selectedSummary;
  }
  if (!containsMissionDiagnosticPrompt(runResult.task.userInput)) {
    return selectedSummary;
  }

  const diagnostics = buildMissionDiagnosticsBlock(runResult);
  const trimmedSummary = selectedSummary.trim();
  const shouldRetainSummaryPrefix =
    /^run skill failed:/i.test(trimmedSummary) ||
    /^i couldn't execute that request in this run\./i.test(trimmedSummary) ||
    /^i couldn't complete that request because a safety policy blocked it\./i.test(trimmedSummary);

  if (shouldRetainSummaryPrefix && trimmedSummary.length > 0) {
    return `${trimmedSummary}\n\n${diagnostics}`;
  }

  return diagnostics;
}
