/**
 * @fileoverview Selects user-facing chat output from task runs, preferring approved `respond` action outputs over technical summaries.
 */

import { extractActiveRequestSegment } from "../../core/currentRequestExtraction";
import { TaskRunResult } from "../../core/types";
import { classifyTrustRenderDecision } from "../trustLexicalClassifier";
import {
  classifyRoutingIntentV1,
  isDiagnosticsRoutingClassification
} from "../routingMap";
import { isLiveBuildVerificationPrompt } from "../liveBuildVerificationPromptPolicy";
import {
  extractBlockedPolicyCodes,
  resolveBlockedActionMessage
} from "./blockSurface";
import { appendMissionDiagnosticsIfRequested } from "./debugSurface";
import {
  buildPartialExecutionBlockedSummary,
  isInspectionOnlyDirectExecutionOutcome
} from "./partialSuccessSurface";
import {
  normalizeUserFacingSummaryOptions,
  UserFacingSummaryOptions
} from "./contracts";
import { stripLabelStyleOpening } from "./languageSurface";
import {
  isClarificationLoopResponse,
  isExecutionCapabilityLimitationResponse,
  isExecutionNoOpResponse,
  isExecutionPolicyRefusalResponse,
  isExecutionStyleRequestPrompt,
  isInstructionalHowToResponse,
  isObservabilityBundleExportPrompt,
  isProgressPlaceholderResponse,
  resolveExecutionSurfaceFallbackFromRouting,
  resolveHighRiskDeleteNoOpFallback,
  resolveProgressPlaceholderFallback,
  resolveRoutingPolicyExplanation
} from "./noOpSurface";
import {
  resolvePrimaryExecutionOutcomeLine,
  resolveTechnicalOutcomeLines,
  UserFacingTechnicalOutcomeLines
} from "./successSurface";
import {
  isCompletedTaskSummary,
  isRunSkillFailureLine,
  resolveSummaryFallback
} from "./stopSummarySurface";
import {
  DEFAULT_TRUST_LEXICAL_RULE_CONTEXT,
  hasApprovedRealNonRespondExecution,
  hasApprovedRealShellExecution,
  hasApprovedSimulatedNonRespondExecution,
  hasApprovedSimulatedShellExecution,
  hasBlockedUnmatchedAction,
  resolveStatusContradictionSafeOutput,
  resolveTrustAwareRespondOutput
} from "./trustSurface";

const EXPLICIT_RUN_SKILL_REQUEST_PATTERN =
  /\b(run|execute|invoke|use)\s+(?:a\s+)?skill\b|\brun[_\s-]?skill\b/i;
const LOCAL_ORGANIZATION_VERB_PATTERN =
  /\b(?:organize|move|group|gather|sort|clean up|put|collect|tidy)\b/i;
const LOCAL_ORGANIZATION_TARGET_PATTERN =
  /\b(?:folder|folders|directory|directories|desktop|documents|downloads|workspace|workspaces|project|projects)\b/i;
const LOCAL_ORGANIZATION_SUCCESS_SUMMARY_PATTERN =
  /^I moved the matching folders into /i;
const LOCAL_ORGANIZATION_PARTIAL_SUMMARY_PATTERN =
  /^The destination now contains /i;
const LOCAL_ORGANIZATION_MOVE_COMMAND_PATTERN = /\b(?:move-item|mv|move)\b/i;

/**
 * Returns `true` when a model-authored reply only reports an inspection-style check despite
 * stronger concrete side effects already being available from the run.
 *
 * @param summary - Candidate respond output.
 * @returns `true` when the reply is too weak to represent the completed work by itself.
 */
function isWeakInspectionSuccessReply(summary: string): boolean {
  const normalized = summary.trim();
  if (!normalized || normalized.length > 220) {
    return false;
  }
  return /^(?:done[.!-]?\s+)?i\s+(?:checked|inspected|looked\s+at)\b/i.test(normalized);
}

/**
 * Returns `true` when the request asks to organize local folders or projects.
 *
 * @param userInput - Raw user wording.
 * @returns `true` when the request is a local organization goal.
 */
function isLocalOrganizationRequest(userInput: string): boolean {
  return (
    LOCAL_ORGANIZATION_VERB_PATTERN.test(userInput) &&
    LOCAL_ORGANIZATION_TARGET_PATTERN.test(userInput)
  );
}

/**
 * Returns `true` when the run still represents local-organization recovery work even if the
 * current user wording was only a short clarification answer.
 *
 * @param runResult - Completed task result being summarized.
 * @returns `true` when the action pattern still proves an organization recovery run.
 */
function isRecoveredLocalOrganizationRun(runResult: TaskRunResult): boolean {
  return (
    runResult.actionResults.some(
      (result) =>
        result.approved &&
        result.action.type === "shell_command" &&
        typeof result.action.params.command === "string" &&
        LOCAL_ORGANIZATION_MOVE_COMMAND_PATTERN.test(result.action.params.command)
    ) &&
    runResult.actionResults.some(
      (result) => result.approved && result.action.type === "stop_process"
    )
  );
}

/**
 * Returns `true` when a direct execution outcome already contains proof-backed local-organization
 * wording, including either full completion or a truthful partial-success summary.
 *
 * @param summary - Candidate direct execution outcome line.
 * @returns `true` when the summary should override a weak inspection-style respond output.
 */
function isProofBackedLocalOrganizationOutcome(summary: string): boolean {
  return (
    LOCAL_ORGANIZATION_SUCCESS_SUMMARY_PATTERN.test(summary) ||
    /^I moved .+ into (?:the requested folder|.+)\./i.test(summary) ||
    LOCAL_ORGANIZATION_PARTIAL_SUMMARY_PATTERN.test(summary)
  );
}

/**
 * Builds a fail-closed summary for organization runs that executed but never proved the move.
 *
 * @returns Human-facing no-proof explanation.
 */
function buildLocalOrganizationNoProofSummary(): string {
  return "I checked the requested folders, but this run did not prove that the matching folders were moved into the requested destination yet.";
}

/**
 * Selects the final message shown to the user from governed run output.
 */
export function selectUserFacingSummary(
  runResult: TaskRunResult,
  options: UserFacingSummaryOptions = {}
): string {
  const activeRequest = extractActiveRequestSegment(runResult.task.userInput);
  const normalizedOptions = normalizeUserFacingSummaryOptions(options);
  const render = (summary: string): string => stripLabelStyleOpening(summary);
  const routingClassification = classifyRoutingIntentV1(runResult.task.userInput);
  const policyCodes = extractBlockedPolicyCodes(runResult);
  const blockedMessage = resolveBlockedActionMessage(
    runResult,
    policyCodes,
    normalizedOptions
  );
  const preferBlockedMessageOverBrowserFailure =
    blockedMessage !== null &&
    isLiveBuildVerificationPrompt(runResult.task.userInput) &&
    (policyCodes.includes("SHELL_DISABLED_BY_POLICY") ||
      policyCodes.includes("PROCESS_DISABLED_BY_POLICY"));
  const outcomes = resolveTechnicalOutcomeLines(runResult);
  const primaryExecutionOutcomeLine = resolvePrimaryExecutionOutcomeLine(outcomes);
  const directExecutionFailureOutcomeLine = outcomes.directExecutionFailureOutcomeLine;
  const approvedRealNonRespondExecution = hasApprovedRealNonRespondExecution(runResult);
  const respondOutputs = runResult.actionResults
    .filter((result) => result.approved && result.action.type === "respond")
    .map((result) => (typeof result.output === "string" ? result.output.trim() : ""))
    .filter((output) => output.length > 0);

  if (respondOutputs.length > 0) {
    const respondSummary = resolveRespondSurfaceSummary(
      runResult,
      respondOutputs[respondOutputs.length - 1],
      activeRequest,
      routingClassification,
      outcomes,
      approvedRealNonRespondExecution,
      policyCodes,
      normalizedOptions,
      blockedMessage
    );
    if (respondSummary !== null) {
      return render(respondSummary);
    }
  }

  if (outcomes.runSkillOutcomeLine) {
    const explicitRunSkillRequest = EXPLICIT_RUN_SKILL_REQUEST_PATTERN.test(
      runResult.task.userInput
    );
    if (
      isRunSkillFailureLine(outcomes.runSkillOutcomeLine) &&
      isExecutionStyleRequestPrompt(runResult.task.userInput) &&
      !explicitRunSkillRequest
    ) {
      return render(appendMissionDiagnosticsIfRequested(
        runResult,
        resolveProgressPlaceholderFallback(runResult, false, false),
        normalizedOptions
      ));
    }
    return render(appendMissionDiagnosticsIfRequested(
      runResult,
      outcomes.runSkillOutcomeLine,
      normalizedOptions
    ));
  }

  if (preferBlockedMessageOverBrowserFailure && blockedMessage) {
    return render(appendMissionDiagnosticsIfRequested(
      runResult,
      blockedMessage,
      normalizedOptions
    ));
  }

  if (
    blockedMessage &&
    !approvedRealNonRespondExecution &&
    !directExecutionFailureOutcomeLine
  ) {
    return render(appendMissionDiagnosticsIfRequested(
      runResult,
      blockedMessage,
      normalizedOptions
    ));
  }

  if (directExecutionFailureOutcomeLine && !approvedRealNonRespondExecution) {
    return render(appendMissionDiagnosticsIfRequested(
      runResult,
      directExecutionFailureOutcomeLine,
      normalizedOptions
    ));
  }

  if (
    !approvedRealNonRespondExecution &&
    routingClassification.routeType === "execution_surface" &&
    !isDiagnosticsRoutingClassification(routingClassification)
  ) {
    const routeFallback = resolveExecutionSurfaceFallbackFromRouting(
      routingClassification,
      runResult.task.userInput
    );
    if (routeFallback) {
      return render(appendMissionDiagnosticsIfRequested(
        runResult,
        routeFallback,
        normalizedOptions
      ));
    }
  }

  if (primaryExecutionOutcomeLine) {
    const primaryExecutionSummary =
      blockedMessage && approvedRealNonRespondExecution
        ? buildPartialExecutionBlockedSummary(
            primaryExecutionOutcomeLine,
            blockedMessage,
            policyCodes
          )
        : primaryExecutionOutcomeLine;
    return render(appendMissionDiagnosticsIfRequested(
      runResult,
      primaryExecutionSummary,
      normalizedOptions
    ));
  }

  if (
    routingClassification.category === "OBSERVABILITY_EXPORT" &&
    isObservabilityBundleExportPrompt(runResult.task.userInput)
  ) {
    const forcedObservabilityFallback =
      resolveExecutionSurfaceFallbackFromRouting(
        routingClassification,
        runResult.task.userInput
      );
    if (forcedObservabilityFallback) {
      return render(appendMissionDiagnosticsIfRequested(
        runResult,
        forcedObservabilityFallback,
        normalizedOptions
      ));
    }
  }

  if (!approvedRealNonRespondExecution) {
    const routingPolicyExplanation = resolveRoutingPolicyExplanation(routingClassification);
    if (routingPolicyExplanation) {
      return render(appendMissionDiagnosticsIfRequested(
        runResult,
        routingPolicyExplanation,
        normalizedOptions
      ));
    }
    if (
      routingClassification.routeType === "execution_surface" &&
      !isDiagnosticsRoutingClassification(routingClassification)
    ) {
      const routeFallback = resolveExecutionSurfaceFallbackFromRouting(
        routingClassification,
        runResult.task.userInput
      );
      if (routeFallback) {
        return render(appendMissionDiagnosticsIfRequested(
          runResult,
          routeFallback,
          normalizedOptions
        ));
      }
    }
  }

  if (!approvedRealNonRespondExecution) {
    const highRiskDeleteFallback = resolveHighRiskDeleteNoOpFallback(
      runResult.task.userInput
    );
    if (highRiskDeleteFallback) {
      return render(appendMissionDiagnosticsIfRequested(
        runResult,
        highRiskDeleteFallback,
        normalizedOptions
      ));
    }
  }

  return render(appendMissionDiagnosticsIfRequested(
    runResult,
    resolveSummaryFallback(runResult, runResult.summary, normalizedOptions),
    normalizedOptions
  ));
}

/**
 * Resolves the respond-driven rendering branch when approved respond output exists.
 */
function resolveRespondSurfaceSummary(
  runResult: TaskRunResult,
  selectedRespondOutput: string,
  activeRequest: string,
  routingClassification: ReturnType<typeof classifyRoutingIntentV1>,
  outcomes: UserFacingTechnicalOutcomeLines,
  approvedRealNonRespondExecution: boolean,
  policyCodes: readonly string[],
  normalizedOptions: ReturnType<typeof normalizeUserFacingSummaryOptions>,
  blockedMessage: string | null
): string | null {
  const primaryExecutionOutcomeLine = resolvePrimaryExecutionOutcomeLine(outcomes);
  const directExecutionFailureOutcomeLine = outcomes.directExecutionFailureOutcomeLine;
  const trustRenderClassification = classifyTrustRenderDecision(
    {
      text: selectedRespondOutput,
      hasApprovedRealShellExecution: hasApprovedRealShellExecution(runResult),
      hasApprovedRealNonRespondExecution: approvedRealNonRespondExecution,
      hasBlockedUnmatchedAction: hasBlockedUnmatchedAction(runResult),
      hasApprovedSimulatedShellExecution: hasApprovedSimulatedShellExecution(runResult),
      hasApprovedSimulatedNonRespondExecution:
        hasApprovedSimulatedNonRespondExecution(runResult)
    },
    DEFAULT_TRUST_LEXICAL_RULE_CONTEXT
  );

  if (trustRenderClassification.decision === "RENDER_BLOCKED") {
    return null;
  }

  const trustedRespondOutput = resolveTrustAwareRespondOutput(
    selectedRespondOutput,
    trustRenderClassification
  );
  const contradictionSafeRespondOutput = resolveStatusContradictionSafeOutput(
    runResult,
    trustedRespondOutput
  );
  const hasTechnicalOutcomeLine = hasAnyTechnicalOutcomeLine(outcomes);
  const executionStylePrompt = isExecutionStyleRequestPrompt(runResult.task.userInput);
  const instructionOnlyNoOp =
    !approvedRealNonRespondExecution &&
    !hasTechnicalOutcomeLine &&
    executionStylePrompt &&
    isInstructionalHowToResponse(contradictionSafeRespondOutput);
  const clarificationOnlyNoOp =
    !approvedRealNonRespondExecution &&
    !hasTechnicalOutcomeLine &&
    executionStylePrompt &&
    isClarificationLoopResponse(contradictionSafeRespondOutput);
  const executionNoOp =
    !approvedRealNonRespondExecution &&
    !hasTechnicalOutcomeLine &&
    executionStylePrompt &&
    isExecutionNoOpResponse(contradictionSafeRespondOutput);
  const executionCapabilityLimitationNoOp =
    !approvedRealNonRespondExecution &&
    !hasTechnicalOutcomeLine &&
    executionStylePrompt &&
    isExecutionCapabilityLimitationResponse(contradictionSafeRespondOutput);
  const policyRefusalNoOp =
    !approvedRealNonRespondExecution &&
    !hasTechnicalOutcomeLine &&
    executionStylePrompt &&
    isExecutionPolicyRefusalResponse(contradictionSafeRespondOutput);
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
    executionCapabilityLimitationNoOp ||
    policyRefusalNoOp
  ) {
    trustedOutputForRender = resolveProgressPlaceholderFallback(
      runResult,
      hasTechnicalOutcomeLine,
      approvedRealNonRespondExecution
    );
  }

  if (
    !approvedRealNonRespondExecution &&
    (executionStylePrompt || routingClassification.routeType === "policy_explanation")
  ) {
    const routingPolicyExplanation = resolveRoutingPolicyExplanation(routingClassification);
    if (routingPolicyExplanation) {
      trustedOutputForRender = routingPolicyExplanation;
    } else if (
      routingClassification.routeType === "execution_surface" &&
      !isDiagnosticsRoutingClassification(routingClassification)
    ) {
      const routeFallback = resolveExecutionSurfaceFallbackFromRouting(
        routingClassification,
        runResult.task.userInput
      );
      if (routeFallback) {
        trustedOutputForRender = routeFallback;
      }
    }
  }

  if (!approvedRealNonRespondExecution && !hasTechnicalOutcomeLine) {
    const highRiskDeleteFallback = resolveHighRiskDeleteNoOpFallback(
      runResult.task.userInput
    );
    if (highRiskDeleteFallback) {
      trustedOutputForRender = highRiskDeleteFallback;
    }
  }

  if (
    routingClassification.category === "OBSERVABILITY_EXPORT" &&
    isObservabilityBundleExportPrompt(runResult.task.userInput) &&
    !hasTechnicalOutcomeLine &&
    isCompletedTaskSummary(trustedOutputForRender)
  ) {
    const forcedObservabilityFallback =
      resolveExecutionSurfaceFallbackFromRouting(
        routingClassification,
        runResult.task.userInput
      );
    if (forcedObservabilityFallback) {
      trustedOutputForRender = forcedObservabilityFallback;
    }
  }

  if (
    routingClassification.category === "LATENCY_BUDGETS" &&
    !hasTechnicalOutcomeLine &&
    !/\b(no-op outcome:|technical reason code:\s*LATENCY_NO_SIDE_EFFECT_EXECUTED)\b/i.test(
      trustedOutputForRender
    ) &&
    (/(reasonCode|Technical reason code):\s*LATENCY_NO_SIDE_EFFECT_EXECUTED/i.test(trustedOutputForRender) ||
      /\bno\s+phase\s+exceeded\b/i.test(trustedOutputForRender) ||
      /\bno\s+execution\s+evidence\b/i.test(trustedOutputForRender))
  ) {
    const forcedLatencyFallback =
      resolveExecutionSurfaceFallbackFromRouting(
        routingClassification,
        runResult.task.userInput
      );
    if (forcedLatencyFallback) {
      trustedOutputForRender = forcedLatencyFallback;
    }
  }

  if (
    approvedRealNonRespondExecution &&
    primaryExecutionOutcomeLine &&
    isWeakInspectionSuccessReply(trustedOutputForRender) &&
    !isWeakInspectionSuccessReply(primaryExecutionOutcomeLine)
  ) {
    trustedOutputForRender =
      blockedMessage && !isInspectionOnlyDirectExecutionOutcome(primaryExecutionOutcomeLine)
        ? buildPartialExecutionBlockedSummary(
            primaryExecutionOutcomeLine,
            blockedMessage,
            policyCodes
          )
        : primaryExecutionOutcomeLine;
  }

  if (
    approvedRealNonRespondExecution &&
    primaryExecutionOutcomeLine &&
    routingClassification.category === "BUILD_SCAFFOLD" &&
    (isExecutionNoOpResponse(trustedOutputForRender) ||
      isExecutionCapabilityLimitationResponse(trustedOutputForRender) ||
      isExecutionPolicyRefusalResponse(trustedOutputForRender))
  ) {
    trustedOutputForRender =
      blockedMessage && !isInspectionOnlyDirectExecutionOutcome(primaryExecutionOutcomeLine)
        ? buildPartialExecutionBlockedSummary(
            primaryExecutionOutcomeLine,
            blockedMessage,
            policyCodes
          )
        : primaryExecutionOutcomeLine;
  }

  if (
    blockedMessage &&
    approvedRealNonRespondExecution &&
    primaryExecutionOutcomeLine &&
    !isInspectionOnlyDirectExecutionOutcome(primaryExecutionOutcomeLine) &&
    (isExecutionNoOpResponse(trustedOutputForRender) ||
      isExecutionCapabilityLimitationResponse(trustedOutputForRender) ||
      isExecutionPolicyRefusalResponse(trustedOutputForRender))
  ) {
    trustedOutputForRender = buildPartialExecutionBlockedSummary(
      primaryExecutionOutcomeLine,
      blockedMessage,
      policyCodes
    );
  }

  if (!approvedRealNonRespondExecution && directExecutionFailureOutcomeLine) {
    trustedOutputForRender = directExecutionFailureOutcomeLine;
  }

  if (
    isLocalOrganizationRequest(activeRequest) ||
    isRecoveredLocalOrganizationRun(runResult) ||
    (outcomes.directExecutionOutcomeLine !== null &&
      isProofBackedLocalOrganizationOutcome(outcomes.directExecutionOutcomeLine))
  ) {
    if (
      outcomes.directExecutionOutcomeLine &&
      isProofBackedLocalOrganizationOutcome(outcomes.directExecutionOutcomeLine)
    ) {
      trustedOutputForRender = outcomes.directExecutionOutcomeLine;
    } else if (blockedMessage) {
      trustedOutputForRender = blockedMessage;
    } else {
      trustedOutputForRender = buildLocalOrganizationNoProofSummary();
    }
  }

  if (!normalizedOptions.showTechnicalSummary) {
    return trustedOutputForRender;
  }

  if (!hasTechnicalOutcomeLine) {
    return appendMissionDiagnosticsIfRequested(
      runResult,
      trustedOutputForRender,
      normalizedOptions
    );
  }

  const technicalLines = buildTechnicalLines(outcomes);
  if (technicalLines.length === 0) {
    return appendMissionDiagnosticsIfRequested(
      runResult,
      trustedOutputForRender,
      normalizedOptions
    );
  }

  return appendMissionDiagnosticsIfRequested(
    runResult,
    `${trustedOutputForRender}\n${technicalLines.join("\n")}`,
    normalizedOptions
  );
}

/**
 * Returns true when any technical outcome line exists.
 */
function hasAnyTechnicalOutcomeLine(outcomes: UserFacingTechnicalOutcomeLines): boolean {
  return (
    outcomes.createSkillOutcomeLine !== null ||
    outcomes.runSkillOutcomeLine !== null ||
    outcomes.managedProcessOutcomeLine !== null ||
    outcomes.probeOutcomeLine !== null ||
    outcomes.browserVerificationOutcomeLine !== null ||
    outcomes.directExecutionFailureOutcomeLine !== null
  );
}

/**
 * Builds the ordered technical lines appended to a trusted respond summary.
 */
function buildTechnicalLines(outcomes: UserFacingTechnicalOutcomeLines): string[] {
  const lines: string[] = [];
  if (outcomes.createSkillOutcomeLine) {
    lines.push(outcomes.createSkillOutcomeLine);
  }
  if (outcomes.runSkillOutcomeLine) {
    lines.push(`Run skill status: ${outcomes.runSkillOutcomeLine}`);
  }
  if (outcomes.managedProcessOutcomeLine) {
    lines.push(`Process status: ${outcomes.managedProcessOutcomeLine}`);
  }
  if (outcomes.probeOutcomeLine) {
    lines.push(`Readiness status: ${outcomes.probeOutcomeLine}`);
  }
  if (outcomes.browserVerificationOutcomeLine) {
    lines.push(`Browser verification: ${outcomes.browserVerificationOutcomeLine}`);
  }
  return lines;
}
