/**
 * @fileoverview Deterministic planner action preparation, validation, and repair-state helpers.
 */

import { PlannedAction } from "../../core/types";
import {
  extractActionCandidates,
  normalizeModelActions
} from "./actionNormalization";
import {
  filterNonExplicitRunSkillActions,
  hasOnlyRunSkillActions,
  hasRequiredAction
} from "./explicitActionIntent";
import {
  normalizeRequiredCreateSkillParams,
  normalizeRequiredRunSkillParams
} from "./skillActionNormalization";
import {
  assessExecutionStyleBuildPlan,
  hasNonRespondAction,
  requiresExecutableBuildPlan
} from "./buildExecutionPolicy";
import { describeExecutionStyleBuildPlanIssue } from "./buildExecutionPlanMessaging";
import {
  extractLinkedPreviewLeaseId,
  hasLinkedPreviewStopProcessAction,
  isWorkspaceRecoveryMarkerRequest,
  normalizeLinkedPreviewShutdownActions,
  normalizeOpenBrowserWorkspaceContext,
  normalizeTrackedArtifactPreviewRefreshActions,
  stripExecutionStyleRespondActions
} from "./explicitActionRepairSupport";
import {
  normalizeNextJsRouteWriteActions,
  normalizeUnsafeFrameworkScaffoldActions
} from "./frameworkActionRepairSupport";
import {
  PlannerActionPreparationResult,
  PlannerExecutionEnvironmentContext,
  PlannerActionValidationResult,
  RequiredActionType
} from "./executionStyleContracts";

/**
 * Normalizes planner output into deterministic actions for the active request.
 */
export function preparePlannerActions(
  plannerOutput: unknown,
  currentUserRequest: string,
  requiredActionType: RequiredActionType,
  fullExecutionInput: string = currentUserRequest,
  executionEnvironment: PlannerExecutionEnvironmentContext | null = null
): PlannerActionPreparationResult {
  let actions = normalizeModelActions(extractActionCandidates(plannerOutput));
  actions = normalizeRequiredCreateSkillParams(
    actions,
    currentUserRequest,
    requiredActionType
  );
  actions = normalizeRequiredRunSkillParams(
    actions,
    currentUserRequest,
      requiredActionType
  );
  actions = stripExecutionStyleRespondActions(actions, currentUserRequest);
  actions = normalizeUnsafeFrameworkScaffoldActions(
    actions,
    currentUserRequest,
    executionEnvironment
  );
  actions = normalizeNextJsRouteWriteActions(
    actions,
    currentUserRequest,
    executionEnvironment
  );
  actions = normalizeTrackedArtifactPreviewRefreshActions(
    actions,
    currentUserRequest,
    requiredActionType,
    fullExecutionInput
  );
  actions = normalizeOpenBrowserWorkspaceContext(actions, fullExecutionInput);
  actions = normalizeLinkedPreviewShutdownActions(
    actions,
    requiredActionType,
    fullExecutionInput
  );
  const filteredRunSkillOnly =
    hasOnlyRunSkillActions(actions) &&
    filterNonExplicitRunSkillActions(actions, currentUserRequest).length === 0;
  return {
    actions: filterNonExplicitRunSkillActions(actions, currentUserRequest),
    filteredRunSkillOnly
  };
}

/**
 * Evaluates whether prepared planner actions satisfy explicit-action and execution-style policy.
 */
export function evaluatePlannerActionValidation(
  currentUserRequest: string,
  requiredActionType: RequiredActionType,
  actions: PlannedAction[],
  fullExecutionInput: string = currentUserRequest,
  executionEnvironment: PlannerExecutionEnvironmentContext | null = null
): PlannerActionValidationResult {
  const linkedPreviewLeaseId = extractLinkedPreviewLeaseId(fullExecutionInput);
  const missingRequiredAction =
    actions.length > 0 &&
    !hasRequiredAction(actions, requiredActionType);
  const missingLinkedPreviewStopProcess =
    actions.length > 0 &&
    requiredActionType === "close_browser" &&
    linkedPreviewLeaseId !== null &&
    !hasLinkedPreviewStopProcessAction(actions, linkedPreviewLeaseId);
  const missingExecutableAction =
    actions.length > 0 &&
    requiresExecutableBuildPlan(currentUserRequest) &&
    !hasNonRespondAction(actions);
  const buildPlanAssessment = assessExecutionStyleBuildPlan(
    currentUserRequest,
    actions,
    requiredActionType,
    executionEnvironment,
    fullExecutionInput
  );
  const invalidExecutionStyleBuildPlan =
    actions.length > 0 && !buildPlanAssessment.valid;
  const repairReason =
    actions.length === 0
      ? "no_valid_actions"
      : missingRequiredAction
        ? `missing_required_action:${requiredActionType}`
        : missingLinkedPreviewStopProcess
          ? `missing_linked_preview_stop_process:${linkedPreviewLeaseId}`
        : missingExecutableAction
          ? "missing_executable_action:execution_style_build"
          : invalidExecutionStyleBuildPlan
            ? `invalid_execution_style_build_plan:${buildPlanAssessment.issueCode ?? "UNKNOWN"}`
            : null;

  return {
    missingRequiredAction,
    missingLinkedPreviewStopProcess,
    missingExecutableAction,
    invalidExecutionStyleBuildPlan,
    buildPlanAssessment,
    needsRepair: repairReason !== null,
    repairReason
  };
}

/**
 * Throws fail-closed planner validation errors using canonical deterministic language.
 */
export function assertPlannerActionValidation(
  validation: PlannerActionValidationResult,
  requiredActionType: RequiredActionType
): void {
  if (validation.missingRequiredAction) {
    throw new Error(
      `Planner model missing required ${requiredActionType} action for explicit user intent.`
    );
  }
  if (validation.missingLinkedPreviewStopProcess) {
    throw new Error(
      "Planner model closed a tracked browser session without stopping the linked preview process."
    );
  }
  if (validation.missingExecutableAction) {
    throw new Error(
      "Planner model returned no executable non-respond actions for execution-style build request."
    );
  }
  if (
    validation.invalidExecutionStyleBuildPlan &&
    validation.buildPlanAssessment.issueCode
  ) {
    throw new Error(
      describeExecutionStyleBuildPlanIssue(validation.buildPlanAssessment.issueCode)
    );
  }
}

/**
 * Evaluates whether run-skill-only collapse should use deterministic respond fallback.
 */
export function shouldUseNonExplicitRunSkillFallback(
  currentUserRequest: string,
  requiredActionType: RequiredActionType,
  ...preparations: readonly PlannerActionPreparationResult[]
): boolean {
  return (
    !isWorkspaceRecoveryMarkerRequest(currentUserRequest) &&
    requiredActionType === null &&
    preparations.some((preparation) => preparation.filteredRunSkillOnly)
  );
}
