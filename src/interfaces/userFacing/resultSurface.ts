/**
 * @fileoverview Selects user-facing chat output from task runs, preferring approved `respond` action outputs over technical summaries.
 */

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

/**
 * Selects the final message shown to the user from governed run output.
 */
export function selectUserFacingSummary(
  runResult: TaskRunResult,
  options: UserFacingSummaryOptions = {}
): string {
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
  const approvedRealNonRespondExecution = hasApprovedRealNonRespondExecution(runResult);
  const respondOutputs = runResult.actionResults
    .filter((result) => result.approved && result.action.type === "respond")
    .map((result) => (typeof result.output === "string" ? result.output.trim() : ""))
    .filter((output) => output.length > 0);

  if (respondOutputs.length > 0) {
    const respondSummary = resolveRespondSurfaceSummary(
      runResult,
      respondOutputs[respondOutputs.length - 1],
      routingClassification,
      outcomes,
      approvedRealNonRespondExecution,
      normalizedOptions
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

  if (outcomes.browserVerificationOutcomeLine) {
    return render(appendMissionDiagnosticsIfRequested(
      runResult,
      outcomes.browserVerificationOutcomeLine,
      normalizedOptions
    ));
  }

  if (blockedMessage) {
    return render(appendMissionDiagnosticsIfRequested(
      runResult,
      blockedMessage,
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

  if (outcomes.directExecutionOutcomeLine) {
    return render(appendMissionDiagnosticsIfRequested(
      runResult,
      outcomes.directExecutionOutcomeLine,
      normalizedOptions
    ));
  }

  if (outcomes.managedProcessOutcomeLine) {
    return render(appendMissionDiagnosticsIfRequested(
      runResult,
      outcomes.managedProcessOutcomeLine,
      normalizedOptions
    ));
  }

  if (outcomes.probeOutcomeLine) {
    return render(appendMissionDiagnosticsIfRequested(
      runResult,
      outcomes.probeOutcomeLine,
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
  routingClassification: ReturnType<typeof classifyRoutingIntentV1>,
  outcomes: UserFacingTechnicalOutcomeLines,
  approvedRealNonRespondExecution: boolean,
  normalizedOptions: ReturnType<typeof normalizeUserFacingSummaryOptions>
): string | null {
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

  return appendMissionDiagnosticsIfRequested(
    runResult,
    `${trustedOutputForRender}\n${buildTechnicalLines(outcomes).join("\n")}`,
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
    outcomes.browserVerificationOutcomeLine !== null
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
