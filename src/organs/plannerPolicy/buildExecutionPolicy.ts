/**
 * @fileoverview Deterministic execution-style build policy and plan-quality guardrails.
 */

import { ActionType, PlannedAction } from "../../core/types";
import {
  ExecutionStyleBuildPlanAssessment,
  ExecutionStyleBuildPlanIssueCode
} from "./executionStyleContracts";
import {
  isExecutionStyleBuildRequest,
  isLiveVerificationBuildRequest,
  requiresBrowserVerificationBuildRequest
} from "./liveVerificationPolicy";

const BUILD_INSPECTION_ONLY_ACTION_TYPES: readonly ActionType[] = [
  "respond",
  "read_file",
  "list_directory",
  "check_process",
  "stop_process"
] as const;
const LIVE_VERIFICATION_ACTION_TYPES: readonly ActionType[] = [
  "start_process",
  "probe_port",
  "probe_http",
  "verify_browser"
] as const;

/**
 * Evaluates whether planner policy may implicitly allow finite shell work for a build request.
 */
export function allowsImplicitFiniteShellForBuildRequest(currentUserRequest: string): boolean {
  return isExecutionStyleBuildRequest(currentUserRequest);
}

/**
 * Evaluates whether planner output must include executable non-respond actions.
 */
export function requiresExecutableBuildPlan(currentUserRequest: string): boolean {
  return isExecutionStyleBuildRequest(currentUserRequest);
}

/**
 * Evaluates whether an action list contains any executable non-respond step.
 */
export function hasNonRespondAction(actions: readonly PlannedAction[]): boolean {
  return actions.some((action) => action.type !== "respond");
}

/**
 * Evaluates whether an action is too weak to satisfy an execution-style build plan on its own.
 */
function isInspectionOnlyBuildAction(action: PlannedAction): boolean {
  return BUILD_INSPECTION_ONLY_ACTION_TYPES.includes(action.type);
}

/**
 * Evaluates whether an action contributes explicit live-verification behavior.
 */
function isLiveVerificationAction(action: PlannedAction): boolean {
  return LIVE_VERIFICATION_ACTION_TYPES.includes(action.type);
}

/**
 * Evaluates whether a planner action list satisfies deterministic execution-style build quality.
 */
export function assessExecutionStyleBuildPlan(
  currentUserRequest: string,
  actions: readonly PlannedAction[]
): ExecutionStyleBuildPlanAssessment {
  if (!requiresExecutableBuildPlan(currentUserRequest)) {
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

/**
 * Resolves a stable human-readable explanation for execution-style build policy failures.
 */
export function describeExecutionStyleBuildPlanIssue(
  issueCode: ExecutionStyleBuildPlanIssueCode
): string {
  switch (issueCode) {
    case "INSPECTION_ONLY_BUILD_PLAN":
      return "Planner model returned inspection-only actions for execution-style build request.";
    case "LIVE_VERIFICATION_ACTION_REQUIRED":
      return "Planner model returned no live-verification actions for execution-style live-run request.";
    case "BROWSER_VERIFICATION_ACTION_REQUIRED":
      return "Planner model returned no verify_browser action for explicit browser/UI verification request.";
    case "START_PROCESS_REQUIRES_PROOF_ACTION":
      return "Planner model started a managed process without a readiness or browser proof action in the same plan.";
  }
}

/**
 * Builds execution-style build action requirement guidance for planner prompts.
 */
export function buildExecutionStyleRequiredActionHint(
  currentUserRequest: string,
  repairMode = false
): string {
  if (!requiresExecutableBuildPlan(currentUserRequest)) {
    return "";
  }

  const prefix = repairMode
    ? "Repair must include at least one executable non-respond action because the current user request is an execution-style build goal."
    : "Current user request is an execution-style build goal. Include at least one executable non-respond action and do not replace the plan with guidance-only respond output.";
  const concreteExecutionClause =
    " Inspection-only actions such as read_file, list_directory, check_process, or stop_process do not satisfy this requirement by themselves.";
  const liveVerificationClause = isLiveVerificationBuildRequest(currentUserRequest)
    ? " For live verification goals, keep finite proof steps first and include at least one live verification action such as start_process, probe_port, probe_http, or verify_browser."
    : "";
  const browserVerificationClause = requiresBrowserVerificationBuildRequest(currentUserRequest)
    ? " When the request explicitly asks to verify the UI or homepage, include verify_browser after loopback readiness is proven."
    : "";
  return ` ${prefix}${concreteExecutionClause}${liveVerificationClause}${browserVerificationClause}`;
}
