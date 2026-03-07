/**
 * @fileoverview Deterministic planner action preparation, validation, and repair-state helpers.
 */

import { PlannedAction } from "../../core/types";
import {
  extractActionCandidates,
  filterNonExplicitRunSkillActions,
  hasOnlyRunSkillActions,
  hasRequiredAction,
  normalizeModelActions,
  normalizeRequiredCreateSkillParams,
  normalizeRequiredRunSkillParams
} from "../plannerHelpers";
import {
  assessExecutionStyleBuildPlan,
  describeExecutionStyleBuildPlanIssue,
  hasNonRespondAction,
  requiresExecutableBuildPlan
} from "./buildExecutionPolicy";
import {
  PlannerActionPreparationResult,
  PlannerActionValidationResult,
  RequiredActionType
} from "./executionStyleContracts";

/**
 * Normalizes planner output into deterministic actions for the active request.
 */
export function preparePlannerActions(
  plannerOutput: unknown,
  currentUserRequest: string,
  requiredActionType: RequiredActionType
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
  actions: PlannedAction[]
): PlannerActionValidationResult {
  const missingRequiredAction =
    actions.length > 0 &&
    !hasRequiredAction(actions, requiredActionType);
  const missingExecutableAction =
    actions.length > 0 &&
    requiresExecutableBuildPlan(currentUserRequest) &&
    !hasNonRespondAction(actions);
  const buildPlanAssessment = assessExecutionStyleBuildPlan(
    currentUserRequest,
    actions
  );
  const invalidExecutionStyleBuildPlan =
    actions.length > 0 && !buildPlanAssessment.valid;
  const repairReason =
    actions.length === 0
      ? "no_valid_actions"
      : missingRequiredAction
        ? `missing_required_action:${requiredActionType}`
        : missingExecutableAction
          ? "missing_executable_action:execution_style_build"
          : invalidExecutionStyleBuildPlan
            ? `invalid_execution_style_build_plan:${buildPlanAssessment.issueCode ?? "UNKNOWN"}`
            : null;

  return {
    missingRequiredAction,
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
  requiredActionType: RequiredActionType,
  ...preparations: readonly PlannerActionPreparationResult[]
): boolean {
  return (
    requiredActionType === null &&
    preparations.some((preparation) => preparation.filteredRunSkillOnly)
  );
}
