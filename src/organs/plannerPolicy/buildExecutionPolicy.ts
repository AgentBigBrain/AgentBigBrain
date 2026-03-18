/**
 * @fileoverview Deterministic execution-style build policy and plan-quality guardrails.
 */

import { PlannedAction } from "../../core/types";
import {
  ExecutionStyleBuildPlanAssessment,
  PlannerExecutionEnvironmentContext,
  RequiredActionType
} from "./executionStyleContracts";
import {
  hasInvalidWindowsOrganizationPowerShellInterpolation,
  hasOrganizationMoveAction,
  hasUnsupportedWorkspaceRecoveryInspectionShellAction,
  hasUnsupportedOpenBrowserTarget,
  hasWorkspaceRecoveryExactStopOrMoveAction,
  hasWorkspaceRecoveryInspectionAction,
  hasInvalidWorkspaceRecoveryInspectionTargets,
  hasFrameworkAppScaffoldAction,
  hasFrameworkAppDirectoryOnlyReuseGuard,
  hasFrameworkAppNonInPlaceScaffoldRepair,
  hasFrameworkAppAdHocPreviewServer,
  hasShellCommandExceedingMaxChars,
  hasUnsupportedWindowsOrganizationShellAction,
  hasOrganizationMoveProofAction,
  isInspectionOnlyBuildAction,
  isLiveVerificationAction,
  isWorkspaceRecoveryExactStopInstruction,
  isWorkspaceRecoveryInspectInstruction,
  isWorkspaceRecoveryPostShutdownRetryInstruction,
  isTrackedArtifactEditPreviewPlan
} from "./buildExecutionActionHeuristics";
import {
  hasBroadProcessNameShutdownAction,
  hasCandidateOnlyHolderShutdownAction,
  hasOrganizationDestinationSelfMatchAction,
  usesSharedDesktopForUserOwnedRequest
} from "./buildExecutionRecoveryPolicy";
import {
  isLocalWorkspaceOrganizationRequest,
  isExecutionStyleBuildRequest,
  isLiveVerificationBuildRequest,
  requiresFrameworkAppScaffoldAction,
  requiresBrowserVerificationBuildRequest,
  requiresPersistentBrowserOpenBuildRequest
} from "./liveVerificationPolicy";

/**
 * Evaluates whether planner policy may implicitly allow finite shell work for a build request.
 */
export function allowsImplicitFiniteShellForBuildRequest(
  currentUserRequest: string,
  fullExecutionInput = currentUserRequest
): boolean {
  return (
    isWorkspaceRecoveryInspectInstruction(fullExecutionInput) ||
    isWorkspaceRecoveryExactStopInstruction(fullExecutionInput) ||
    isWorkspaceRecoveryPostShutdownRetryInstruction(fullExecutionInput) ||
    isExecutionStyleBuildRequest(currentUserRequest) ||
    isLocalWorkspaceOrganizationRequest(currentUserRequest)
  );
}

/**
 * Evaluates whether planner output must include executable non-respond actions.
 */
export function requiresExecutableBuildPlan(
  currentUserRequest: string,
  fullExecutionInput = currentUserRequest
): boolean {
  return (
    isWorkspaceRecoveryInspectInstruction(fullExecutionInput) ||
    isWorkspaceRecoveryExactStopInstruction(fullExecutionInput) ||
    isWorkspaceRecoveryPostShutdownRetryInstruction(fullExecutionInput) ||
    isExecutionStyleBuildRequest(currentUserRequest) ||
    isLocalWorkspaceOrganizationRequest(currentUserRequest)
  );
}

/**
 * Evaluates whether an action list contains any executable non-respond step.
 */
export function hasNonRespondAction(actions: readonly PlannedAction[]): boolean {
  return actions.some((action) => action.type !== "respond");
}

/**
 * Evaluates whether a planner action list satisfies deterministic execution-style build quality.
 */
export function assessExecutionStyleBuildPlan(
  currentUserRequest: string,
  actions: readonly PlannedAction[],
  requiredActionType: RequiredActionType | null = null,
  executionEnvironment: PlannerExecutionEnvironmentContext | null = null,
  fullExecutionInput = currentUserRequest
): ExecutionStyleBuildPlanAssessment {
  if (!requiresExecutableBuildPlan(currentUserRequest, fullExecutionInput)) {
    return {
      valid: true,
      issueCode: null
    };
  }

  if (
    hasUnsupportedWindowsOrganizationShellAction(
      currentUserRequest,
      actions,
      executionEnvironment
    )
  ) {
    return {
      valid: false,
      issueCode: "WINDOWS_ORGANIZATION_REQUIRES_POWERSHELL"
    };
  }

  if (
    hasInvalidWindowsOrganizationPowerShellInterpolation(
      currentUserRequest,
      actions,
      executionEnvironment
    )
  ) {
    return {
      valid: false,
      issueCode: "WINDOWS_ORGANIZATION_INVALID_POWERSHELL_INTERPOLATION"
    };
  }

  if (hasBroadProcessNameShutdownAction(actions)) {
    return {
      valid: false,
      issueCode: "BROAD_PROCESS_SHUTDOWN_DISALLOWED"
    };
  }

  if (hasCandidateOnlyHolderShutdownAction(currentUserRequest, actions)) {
    return {
      valid: false,
      issueCode: "CANDIDATE_HOLDER_SHUTDOWN_REQUIRES_INSPECTION"
    };
  }

  if (hasUnsupportedWorkspaceRecoveryInspectionShellAction(fullExecutionInput, actions)) {
    return {
      valid: false,
      issueCode: "WORKSPACE_RECOVERY_RUNTIME_INSPECTION_REQUIRED"
    };
  }

  if (hasInvalidWorkspaceRecoveryInspectionTargets(fullExecutionInput, actions)) {
    return {
      valid: false,
      issueCode: "WORKSPACE_RECOVERY_EXACT_PATH_INSPECTION_REQUIRED"
    };
  }

  if (isWorkspaceRecoveryInspectInstruction(fullExecutionInput)) {
    return hasWorkspaceRecoveryInspectionAction(actions)
      ? {
          valid: true,
          issueCode: null
        }
      : {
          valid: false,
          issueCode: "WORKSPACE_RECOVERY_RUNTIME_INSPECTION_REQUIRED"
        };
  }

  if (isWorkspaceRecoveryExactStopInstruction(fullExecutionInput)) {
    if (hasOrganizationDestinationSelfMatchAction(currentUserRequest, actions)) {
      return {
        valid: false,
        issueCode: "LOCAL_ORGANIZATION_DESTINATION_SELF_MATCH_DISALLOWED"
      };
    }
    return hasWorkspaceRecoveryExactStopOrMoveAction(actions)
      ? {
          valid: true,
          issueCode: null
        }
      : {
          valid: false,
          issueCode: "WORKSPACE_RECOVERY_STOP_OR_MOVE_REQUIRED"
        };
  }

  if (isWorkspaceRecoveryPostShutdownRetryInstruction(fullExecutionInput)) {
    if (hasOrganizationDestinationSelfMatchAction(currentUserRequest, actions)) {
      return {
        valid: false,
        issueCode: "LOCAL_ORGANIZATION_DESTINATION_SELF_MATCH_DISALLOWED"
      };
    }
    if (!hasOrganizationMoveAction(actions)) {
      return {
        valid: false,
        issueCode: "LOCAL_ORGANIZATION_SHELL_ACTION_REQUIRED"
      };
    }
    if (!hasOrganizationMoveProofAction(actions)) {
      return {
        valid: false,
        issueCode: "LOCAL_ORGANIZATION_PROOF_REQUIRED"
      };
    }
    return {
      valid: true,
      issueCode: null
    };
  }

  if (actions.length === 0 || actions.every((action) => isInspectionOnlyBuildAction(action))) {
    return {
      valid: false,
      issueCode: "INSPECTION_ONLY_BUILD_PLAN"
    };
  }

  if (hasShellCommandExceedingMaxChars(actions, executionEnvironment)) {
    return {
      valid: false,
      issueCode: "SHELL_COMMAND_MAX_CHARS_EXCEEDED"
    };
  }

  if (
    isLocalWorkspaceOrganizationRequest(currentUserRequest) &&
    !hasOrganizationMoveAction(actions)
  ) {
    return {
      valid: false,
      issueCode: "LOCAL_ORGANIZATION_SHELL_ACTION_REQUIRED"
    };
  }

  if (
    isLocalWorkspaceOrganizationRequest(currentUserRequest) &&
    hasOrganizationDestinationSelfMatchAction(currentUserRequest, actions)
  ) {
    return {
      valid: false,
      issueCode: "LOCAL_ORGANIZATION_DESTINATION_SELF_MATCH_DISALLOWED"
    };
  }

  if (
    isLocalWorkspaceOrganizationRequest(currentUserRequest) &&
    !hasOrganizationMoveProofAction(actions)
  ) {
    return {
      valid: false,
      issueCode: "LOCAL_ORGANIZATION_PROOF_REQUIRED"
    };
  }

  if (
    isTrackedArtifactEditPreviewPlan(
      requiredActionType,
      currentUserRequest,
      fullExecutionInput,
      actions
    )
  ) {
    return {
      valid: true,
      issueCode: null
    };
  }

  if (!isExecutionStyleBuildRequest(currentUserRequest)) {
    return {
      valid: true,
      issueCode: null
    };
  }

  if (
    requiresFrameworkAppScaffoldAction(currentUserRequest) &&
    hasNonRespondAction(actions) &&
    !hasFrameworkAppScaffoldAction(currentUserRequest, actions)
  ) {
    return {
      valid: false,
      issueCode: "FRAMEWORK_APP_SCAFFOLD_ACTION_REQUIRED"
    };
  }

  if (
    requiresFrameworkAppScaffoldAction(currentUserRequest) &&
    hasFrameworkAppDirectoryOnlyReuseGuard(currentUserRequest, actions)
  ) {
    return {
      valid: false,
      issueCode: "FRAMEWORK_APP_ARTIFACT_CHECK_REQUIRED"
    };
  }

  if (
    requiresFrameworkAppScaffoldAction(currentUserRequest) &&
    hasFrameworkAppNonInPlaceScaffoldRepair(currentUserRequest, actions)
  ) {
    return {
      valid: false,
      issueCode: "FRAMEWORK_APP_IN_PLACE_SCAFFOLD_REQUIRED"
    };
  }

  if (
    requiresFrameworkAppScaffoldAction(currentUserRequest) &&
    hasFrameworkAppAdHocPreviewServer(currentUserRequest, actions)
  ) {
    return {
      valid: false,
      issueCode: "FRAMEWORK_APP_NATIVE_PREVIEW_REQUIRED"
    };
  }

  if (
    usesSharedDesktopForUserOwnedRequest(currentUserRequest, actions)
  ) {
    return {
      valid: false,
      issueCode: "SHARED_DESKTOP_PATH_DISALLOWED"
    };
  }

  if (hasUnsupportedOpenBrowserTarget(currentUserRequest, actions)) {
    return {
      valid: false,
      issueCode: "OPEN_BROWSER_HTTP_URL_REQUIRED"
    };
  }

  if (
    isLiveVerificationBuildRequest(currentUserRequest) &&
    !actions.some((action) => isLiveVerificationAction(action))
  ) {
    return {
      valid: false,
      issueCode: "LIVE_VERIFICATION_ACTION_REQUIRED"
    };
  }

  if (
    requiresBrowserVerificationBuildRequest(currentUserRequest) &&
    !actions.some((action) => action.type === "verify_browser")
  ) {
    return {
      valid: false,
      issueCode: "BROWSER_VERIFICATION_ACTION_REQUIRED"
    };
  }

  if (
    requiresPersistentBrowserOpenBuildRequest(currentUserRequest) &&
    !actions.some((action) => action.type === "open_browser")
  ) {
    return {
      valid: false,
      issueCode: "PERSISTENT_BROWSER_OPEN_REQUIRED"
    };
  }

  if (
    actions.some((action) => action.type === "start_process") &&
    !actions.some(
      (action) =>
        action.type === "probe_port" ||
        action.type === "probe_http" ||
        action.type === "verify_browser"
    )
  ) {
    return {
      valid: false,
      issueCode: "START_PROCESS_REQUIRES_PROOF_ACTION"
    };
  }

  return {
    valid: true,
    issueCode: null
  };
}
