/**
 * @fileoverview Selects user-facing chat output from task runs, preferring approved `respond` action outputs over technical summaries.
 */

import { MissionTimelineV1, TaskRunResult } from "../core/types";
import {
  buildMissionUxResultEnvelope,
  deriveMissionUxState,
  determineApprovalGranularity,
  formatStableApprovalDiff
} from "../core/stage6_85MissionUxPolicy";
import { evaluateVerificationGate } from "../core/stage6_85QualityGatePolicy";
import {
  buildMissionTimelineV1,
  explainFailureDeterministically
} from "../core/stage6_85ObservabilityPolicy";
import { classifyTrustRenderDecision } from "./trustLexicalClassifier";
import {
  DEFAULT_TRUST_LEXICAL_RULE_CONTEXT,
  hasApprovedRealNonRespondExecution,
  hasApprovedRealShellExecution,
  hasApprovedSimulatedNonRespondExecution,
  hasApprovedSimulatedShellExecution,
  hasBlockedUnmatchedAction,
  resolveTrustAwareRespondOutput
} from "./userFacingTrustPolicy";
import {
  containsApprovalFlowPrompt,
  containsMissionDiagnosticPrompt,
  extractFirstPersonStatusUpdate,
  resolveVerificationCategoryForPrompt,
  shouldEvaluateVerificationGateForDiagnostics
} from "./diagnosticsPromptPolicy";
import {
  classifyRoutingIntentV1,
  isDiagnosticsRoutingClassification
} from "./routingMap";
import { applyTruthPolicyV1ToOutcomeSummary } from "./userFacingContracts";
import {
  extractBlockedPolicyCodes,
  resolveBlockedActionMessage
} from "./userFacingBlockPolicy";
import {
  isClarificationLoopResponse,
  isExecutionCapabilityLimitationResponse,
  isExecutionNoOpResponse,
  isExecutionStyleRequestPrompt,
  isObservabilityBundleExportPrompt,
  isInstructionalHowToResponse,
  isProgressPlaceholderResponse,
  resolveExecutionSurfaceFallbackFromRouting,
  resolveProgressPlaceholderFallback,
  resolveRoutingPolicyExplanation
} from "./userFacingNoOpPolicy";

export interface UserFacingSummaryOptions {
  showTechnicalSummary?: boolean;
  showSafetyCodes?: boolean;
}

const COMPLETED_TASK_SUMMARY_PREFIX = "completed task with";
const STATUS_CONTRADICTION_CUE_PATTERNS: readonly RegExp[] = [
  /\b(?:my\s+records?|records?|memory|earlier)\b.*\b(?:show|shows|indicate|indicates)\b/i,
  /\bit\s+seems\s+there\s+might\s+be\s+a\s+misunderstanding\b/i
] as const;

/**
 * Derives stage685 tier from action type from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for stage685 tier from action type in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param actionType - Value for action type.
 * @returns Computed `number | null` result.
 */
function deriveStage685TierFromActionType(actionType: string): number | null {
  if (actionType === "respond") {
    return 0;
  }
  if (actionType === "read_file" || actionType === "list_directory") {
    return 1;
  }
  if (
    actionType === "write_file" ||
    actionType === "delete_file" ||
    actionType === "create_skill" ||
    actionType === "run_skill" ||
    actionType === "network_write" ||
    actionType === "shell_command" ||
    actionType === "self_modify"
  ) {
    return 3;
  }
  return null;
}

/**
 * Formats action types as a deterministic, deduplicated display list.
 *
 * **Why it exists:**
 * Keeps `format unique action type list` logic in one place to reduce behavior drift.
 *
 * **What it talks to:**
 * - Local de-duplication and sorting logic only.
 *
 * @param actionTypes - Action types collected from plan or execution results.
 * @returns Comma-separated, alphabetized list of unique action types (or `none`).
 */
function formatUniqueActionTypeList(actionTypes: readonly string[]): string {
  const uniqueSorted = Array.from(new Set(actionTypes.filter((value) => value.trim().length > 0))).sort(
    (left, right) => left.localeCompare(right)
  );
  return uniqueSorted.length > 0 ? uniqueSorted.join(", ") : "none";
}

/**
 * Evaluates respond only plan and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the respond only plan policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `TaskRunResult` (import `TaskRunResult`) from `../core/types`.
 *
 * @param runResult - Result payload being inspected or transformed.
 * @returns `true` when the function's policy/check conditions pass.
 */
function isRespondOnlyPlan(runResult: TaskRunResult): boolean {
  if (runResult.plan.actions.length === 0) {
    return false;
  }
  return runResult.plan.actions.every((action) => action.type === "respond");
}

/**
 * Constructs a compact mission timeline from planner/execution outcomes.
 *
 * **Why it exists:**
 * Keeps construction of mission timeline from run result consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `buildMissionTimelineV1` (import `buildMissionTimelineV1`) from `../core/stage6_85ObservabilityPolicy`.
 * - Uses `MissionTimelineV1` (import `MissionTimelineV1`) from `../core/types`.
 * - Uses `TaskRunResult` (import `TaskRunResult`) from `../core/types`.
 * - Uses `applyTruthPolicyV1ToOutcomeSummary` (import `applyTruthPolicyV1ToOutcomeSummary`) from `./userFacingContracts`.
 *
 * @param runResult - Result object inspected or transformed in this step.
 * @returns Computed `MissionTimelineV1` result.
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
 *
 * **Why it exists:**
 * Keeps construction of mission diagnostics block consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `buildMissionUxResultEnvelope` (import `buildMissionUxResultEnvelope`) from `../core/stage6_85MissionUxPolicy`.
 * - Uses `deriveMissionUxState` (import `deriveMissionUxState`) from `../core/stage6_85MissionUxPolicy`.
 * - Uses `determineApprovalGranularity` (import `determineApprovalGranularity`) from `../core/stage6_85MissionUxPolicy`.
 * - Uses `formatStableApprovalDiff` (import `formatStableApprovalDiff`) from `../core/stage6_85MissionUxPolicy`.
 * - Uses `explainFailureDeterministically` (import `explainFailureDeterministically`) from `../core/stage6_85ObservabilityPolicy`.
 * - Uses `evaluateVerificationGate` (import `evaluateVerificationGate`) from `../core/stage6_85QualityGatePolicy`.
 * - Additional imported collaborators are also used in this function body.
 *
 * @param runResult - Result object inspected or transformed in this step.
 * @returns Resulting string value.
 */
function buildMissionDiagnosticsBlock(runResult: TaskRunResult): string {
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
 *
 * **Why it exists:**
 * Diagnostic output should appear only in technical-summary mode and only when prompted, while
 * preserving normal conversational responses for non-diagnostic requests.
 *
 * **What it talks to:**
 * - Uses `TaskRunResult` (import `TaskRunResult`) from `../core/types`.
 *
 * @param runResult - Completed run result being rendered.
 * @param selectedSummary - Current summary selected by earlier rendering logic.
 * @param options - User-facing rendering options.
 * @returns Original summary or summary + diagnostics block when requested.
 */
function appendMissionDiagnosticsIfRequested(
  runResult: TaskRunResult,
  selectedSummary: string,
  options: Required<UserFacingSummaryOptions>
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
    /^i couldn't complete that request because a safety policy blocked it\./i.test(trimmedSummary);

  if (shouldRetainSummaryPrefix && trimmedSummary.length > 0) {
    return `${trimmedSummary}\n\n${diagnostics}`;
  }

  return diagnostics;
}

/**
 * Evaluates completed task summary and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the completed task summary policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param summary - Message/text content processed by this function.
 * @returns `true` when this check passes.
 */
function isCompletedTaskSummary(summary: string): boolean {
  return summary.trim().toLowerCase().startsWith(COMPLETED_TASK_SUMMARY_PREFIX);
}

/**
 * Resolves summary fallback from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of summary fallback by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `TaskRunResult` (import `TaskRunResult`) from `../core/types`.
 * - Uses `applyTruthPolicyV1ToOutcomeSummary` (import `applyTruthPolicyV1ToOutcomeSummary`) from `./userFacingContracts`.
 *
 * @param runResult - Result object inspected or transformed in this step.
 * @param summary - Message/text content processed by this function.
 * @param options - Optional tuning knobs for this operation.
 * @returns Resulting string value.
 */
function resolveSummaryFallback(
  runResult: TaskRunResult,
  summary: string,
  options: Required<UserFacingSummaryOptions>
): string {
  const truthSafeSummary = applyTruthPolicyV1ToOutcomeSummary(summary, runResult);
  if (options.showTechnicalSummary) {
    return truthSafeSummary;
  }

  if (isCompletedTaskSummary(truthSafeSummary)) {
    return "Done.";
  }

  return truthSafeSummary;
}

/**
 * Resolves status contradiction safe output from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of status contradiction safe output by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `TaskRunResult` (import `TaskRunResult`) from `../core/types`.
 *
 * @param runResult - Result payload being inspected or transformed.
 * @param selectedRespondOutput - Result payload being inspected or transformed.
 * @returns Reply text with contradiction-safe phrasing when a status mismatch is detected.
 */
function resolveStatusContradictionSafeOutput(
  runResult: TaskRunResult,
  selectedRespondOutput: string
): string {
  const statusUpdate = extractFirstPersonStatusUpdate(runResult.task.userInput);
  if (!statusUpdate) {
    return selectedRespondOutput;
  }
  const hasContradictionCue = STATUS_CONTRADICTION_CUE_PATTERNS.some((pattern) =>
    pattern.test(selectedRespondOutput)
  );
  if (!hasContradictionCue) {
    return selectedRespondOutput;
  }

  return [
    `Noted: ${statusUpdate}.`,
    "I will treat this as the latest status for this turn.",
    "If needed, I can help with the next step."
  ].join(" ");
}

/**
 * Resolves create skill outcome line from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of create skill outcome line by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `TaskRunResult` (import `TaskRunResult`) from `../core/types`.
 *
 * @param runResult - Result object inspected or transformed in this step.
 * @returns Computed `string | null` result.
 */
function resolveCreateSkillOutcomeLine(runResult: TaskRunResult): string | null {
  const createSkillResults = runResult.actionResults.filter(
    (result) => result.action.type === "create_skill"
  );
  if (createSkillResults.length === 0) {
    return null;
  }

  const approvedCreateSkillResults = createSkillResults.filter(
    (result) => result.approved
  );
  if (approvedCreateSkillResults.length > 0) {
    const output = [...approvedCreateSkillResults]
      .reverse()
      .map((result) => (typeof result.output === "string" ? result.output.trim() : ""))
      .find((value) => value.length > 0);
    if (output) {
      return `Skill status: ${output}`;
    }
    return "Skill status: created successfully.";
  }

  const blockedCodes = Array.from(
    new Set(
      createSkillResults
        .filter((result) => !result.approved)
        .flatMap((result) => result.blockedBy)
        .map((code) => code.trim())
        .filter((code) => code.length > 0)
    )
  );
  if (blockedCodes.length > 0) {
    return `Skill status: blocked (${blockedCodes.join(", ")}).`;
  }

  return "Skill status: blocked.";
}

/**
 * Resolves run skill outcome line from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of run skill outcome line by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `TaskRunResult` (import `TaskRunResult`) from `../core/types`.
 *
 * @param runResult - Result object inspected or transformed in this step.
 * @returns Computed `string | null` result.
 */
function resolveRunSkillOutcomeLine(runResult: TaskRunResult): string | null {
  const runSkillResults = runResult.actionResults.filter(
    (result) => result.action.type === "run_skill"
  );
  if (runSkillResults.length === 0) {
    return null;
  }

  const approvedRunSkillResults = runSkillResults.filter(
    (result) => result.approved
  );
  if (approvedRunSkillResults.length > 0) {
    const output = [...approvedRunSkillResults]
      .reverse()
      .map((result) => (typeof result.output === "string" ? result.output.trim() : ""))
      .find((value) => value.length > 0);
    if (output) {
      return output;
    }
    return "Run skill success.";
  }

  const failedRunSkillOutput = [...runSkillResults]
    .reverse()
    .map((result) => (typeof result.output === "string" ? result.output.trim() : ""))
    .find((value) => value.toLowerCase().startsWith("run skill failed:"));
  if (failedRunSkillOutput) {
    return failedRunSkillOutput;
  }
  return null;
}

/**
 * Evaluates run skill failure line and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the run skill failure line policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Local regex check only.
 *
 * @param value - Primary input consumed by this function.
 * @returns `true` when this check/policy condition passes.
 */
function isRunSkillFailureLine(value: string): boolean {
  return /^run skill failed:/i.test(value.trim());
}

/**
 * Selects the final message shown to the user from governed run output.
 *
 * **Why it exists:**
 * User-facing truthfulness rules are spread across multiple signals (approved `respond` content,
 * trust lexical classification, blocked policy codes, technical diagnostics toggles, and fallback
 * summaries). This function centralizes that policy so interfaces present one consistent answer.
 *
 * **What it talks to:**
 * - Uses `TaskRunResult` (import `TaskRunResult`) from `../core/types`.
 * - Uses `classifyRoutingIntentV1` (import `classifyRoutingIntentV1`) from `./routingMap`.
 * - Uses `isDiagnosticsRoutingClassification` (import `isDiagnosticsRoutingClassification`) from `./routingMap`.
 * - Uses `classifyTrustRenderDecision` (import `classifyTrustRenderDecision`) from `./trustLexicalClassifier`.
 *
 * @param runResult - Full task execution result from orchestrator/task runner.
 * @param options - Rendering toggles for technical summary and safety-code visibility.
 * @returns User-visible summary text that honors truth/overclaim constraints.
 */
export function selectUserFacingSummary(
  runResult: TaskRunResult,
  options: UserFacingSummaryOptions = {}
): string {
  const showTechnicalSummary = options.showTechnicalSummary !== false;
  const normalizedOptions: Required<UserFacingSummaryOptions> = {
    showTechnicalSummary,
    showSafetyCodes: options.showSafetyCodes ?? showTechnicalSummary
  };
  const routingClassification = classifyRoutingIntentV1(runResult.task.userInput);

  const policyCodes = extractBlockedPolicyCodes(runResult);
  const respondOutputs = runResult.actionResults
    .filter((result) => result.approved && result.action.type === "respond")
    .map((result) => (typeof result.output === "string" ? result.output.trim() : ""))
    .filter((output) => output.length > 0);

  if (respondOutputs.length > 0) {
    const selectedRespondOutput = respondOutputs[respondOutputs.length - 1];
    const trustRenderClassification = classifyTrustRenderDecision(
      {
        text: selectedRespondOutput,
        hasApprovedRealShellExecution: hasApprovedRealShellExecution(runResult),
        hasApprovedRealNonRespondExecution: hasApprovedRealNonRespondExecution(runResult),
        hasBlockedUnmatchedAction: hasBlockedUnmatchedAction(runResult),
        hasApprovedSimulatedShellExecution: hasApprovedSimulatedShellExecution(runResult),
        hasApprovedSimulatedNonRespondExecution:
          hasApprovedSimulatedNonRespondExecution(runResult)
      },
      DEFAULT_TRUST_LEXICAL_RULE_CONTEXT
    );

    if (trustRenderClassification.decision !== "RENDER_BLOCKED") {
      const trustedRespondOutput = resolveTrustAwareRespondOutput(
        selectedRespondOutput,
        trustRenderClassification
      );
      const contradictionSafeRespondOutput = resolveStatusContradictionSafeOutput(
        runResult,
        trustedRespondOutput
      );
      const approvedRealNonRespondExecution = hasApprovedRealNonRespondExecution(runResult);
      const createSkillOutcomeLine = resolveCreateSkillOutcomeLine(runResult);
      const runSkillOutcomeLine = resolveRunSkillOutcomeLine(runResult);
      const hasTechnicalOutcomeLine =
        createSkillOutcomeLine !== null || runSkillOutcomeLine !== null;
      const instructionOnlyNoOp =
        !approvedRealNonRespondExecution &&
        !hasTechnicalOutcomeLine &&
        isExecutionStyleRequestPrompt(runResult.task.userInput) &&
        isInstructionalHowToResponse(contradictionSafeRespondOutput);
      const clarificationOnlyNoOp =
        !approvedRealNonRespondExecution &&
        !hasTechnicalOutcomeLine &&
        isExecutionStyleRequestPrompt(runResult.task.userInput) &&
        isClarificationLoopResponse(contradictionSafeRespondOutput);
      const executionNoOp =
        !approvedRealNonRespondExecution &&
        !hasTechnicalOutcomeLine &&
        isExecutionStyleRequestPrompt(runResult.task.userInput) &&
        isExecutionNoOpResponse(contradictionSafeRespondOutput);
      const executionCapabilityLimitationNoOp =
        !approvedRealNonRespondExecution &&
        !hasTechnicalOutcomeLine &&
        isExecutionStyleRequestPrompt(runResult.task.userInput) &&
        isExecutionCapabilityLimitationResponse(contradictionSafeRespondOutput);
      let trustedOutputForRender = contradictionSafeRespondOutput;
      if (isProgressPlaceholderResponse(contradictionSafeRespondOutput, runResult.task.userInput)) {
        trustedOutputForRender = resolveProgressPlaceholderFallback(
          runResult,
          hasTechnicalOutcomeLine,
          approvedRealNonRespondExecution
        );
      } else if (
        instructionOnlyNoOp ||
        clarificationOnlyNoOp ||
        executionNoOp ||
        executionCapabilityLimitationNoOp
      ) {
        trustedOutputForRender = resolveProgressPlaceholderFallback(
          runResult,
          hasTechnicalOutcomeLine,
          approvedRealNonRespondExecution
        );
      }
      if (
        !approvedRealNonRespondExecution &&
        (isExecutionStyleRequestPrompt(runResult.task.userInput) ||
          routingClassification.routeType === "policy_explanation")
      ) {
        const routingPolicyExplanation = resolveRoutingPolicyExplanation(routingClassification);
        if (routingPolicyExplanation) {
          trustedOutputForRender = routingPolicyExplanation;
        } else if (
          routingClassification.routeType === "execution_surface" &&
          !isDiagnosticsRoutingClassification(routingClassification)
        ) {
          const routeFallback = resolveExecutionSurfaceFallbackFromRouting(routingClassification);
          if (routeFallback) {
            trustedOutputForRender = routeFallback;
          }
        }
      }
      if (
        routingClassification.category === "OBSERVABILITY_EXPORT" &&
        isObservabilityBundleExportPrompt(runResult.task.userInput) &&
        !hasTechnicalOutcomeLine &&
        isCompletedTaskSummary(trustedOutputForRender)
      ) {
        const forcedObservabilityFallback =
          resolveExecutionSurfaceFallbackFromRouting(routingClassification);
        if (forcedObservabilityFallback) {
          trustedOutputForRender = forcedObservabilityFallback;
        }
      }
      if (
        routingClassification.category === "LATENCY_BUDGETS" &&
        !hasTechnicalOutcomeLine &&
        !/\bno-op outcome:/i.test(trustedOutputForRender) &&
        (/reasonCode:\s*LATENCY_NO_SIDE_EFFECT_EXECUTED/i.test(trustedOutputForRender) ||
          /\bno\s+phase\s+exceeded\b/i.test(trustedOutputForRender) ||
          /\bno\s+execution\s+evidence\b/i.test(trustedOutputForRender))
      ) {
        const forcedLatencyFallback =
          resolveExecutionSurfaceFallbackFromRouting(routingClassification);
        if (forcedLatencyFallback) {
          trustedOutputForRender = forcedLatencyFallback;
        }
      }
      if (!normalizedOptions.showTechnicalSummary) {
        return trustedOutputForRender;
      }

      if (!createSkillOutcomeLine && !runSkillOutcomeLine) {
        return appendMissionDiagnosticsIfRequested(
          runResult,
          trustedOutputForRender,
          normalizedOptions
        );
      }
      const technicalLines: string[] = [];
      if (createSkillOutcomeLine) {
        technicalLines.push(createSkillOutcomeLine);
      }
      if (runSkillOutcomeLine) {
        technicalLines.push(`Run skill status: ${runSkillOutcomeLine}`);
      }
      return appendMissionDiagnosticsIfRequested(
        runResult,
        `${trustedOutputForRender}\n${technicalLines.join("\n")}`,
        normalizedOptions
      );
    }
  }

  const runSkillOutcomeLine = resolveRunSkillOutcomeLine(runResult);
  if (runSkillOutcomeLine) {
    if (
      isRunSkillFailureLine(runSkillOutcomeLine) &&
      isExecutionStyleRequestPrompt(runResult.task.userInput)
    ) {
      return appendMissionDiagnosticsIfRequested(
        runResult,
        resolveProgressPlaceholderFallback(runResult, false, false),
        normalizedOptions
      );
    }
    return appendMissionDiagnosticsIfRequested(
      runResult,
      runSkillOutcomeLine,
      normalizedOptions
    );
  }

  if (
    routingClassification.category === "OBSERVABILITY_EXPORT" &&
    isObservabilityBundleExportPrompt(runResult.task.userInput)
  ) {
    const forcedObservabilityFallback =
      resolveExecutionSurfaceFallbackFromRouting(routingClassification);
    if (forcedObservabilityFallback) {
      return appendMissionDiagnosticsIfRequested(
        runResult,
        forcedObservabilityFallback,
        normalizedOptions
      );
    }
  }

  if (!hasApprovedRealNonRespondExecution(runResult)) {
    const routingPolicyExplanation = resolveRoutingPolicyExplanation(routingClassification);
    if (routingPolicyExplanation) {
      return appendMissionDiagnosticsIfRequested(
        runResult,
        routingPolicyExplanation,
        normalizedOptions
      );
    }
    if (
      routingClassification.routeType === "execution_surface" &&
      !isDiagnosticsRoutingClassification(routingClassification)
    ) {
      const routeFallback = resolveExecutionSurfaceFallbackFromRouting(routingClassification);
      if (routeFallback) {
        return appendMissionDiagnosticsIfRequested(
          runResult,
          routeFallback,
          normalizedOptions
        );
      }
    }
  }

  const blockedMessage = resolveBlockedActionMessage(
    runResult,
    policyCodes,
    normalizedOptions
  );
  if (blockedMessage) {
    return appendMissionDiagnosticsIfRequested(
      runResult,
      blockedMessage,
      normalizedOptions
    );
  }

  return appendMissionDiagnosticsIfRequested(
    runResult,
    resolveSummaryFallback(runResult, runResult.summary, normalizedOptions),
    normalizedOptions
  );
}
