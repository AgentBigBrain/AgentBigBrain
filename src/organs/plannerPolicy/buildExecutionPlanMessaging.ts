/**
 * @fileoverview Human-facing messaging helpers for execution-style build-plan policy.
 */

import { ExecutionStyleBuildPlanIssueCode } from "./executionStyleContracts";
import {
  isLiveVerificationBuildRequest,
  isLocalWorkspaceOrganizationRequest,
  requiresBrowserVerificationBuildRequest,
  requiresPersistentBrowserOpenBuildRequest
} from "./liveVerificationPolicy";
import { requiresExecutableBuildPlan } from "./buildExecutionPolicy";

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
    case "PERSISTENT_BROWSER_OPEN_REQUIRED":
      return "Planner model returned no open_browser action for an explicit leave-it-open browser request.";
    case "OPEN_BROWSER_HTTP_URL_REQUIRED":
      return "Planner model returned open_browser with a target that is invalid for this request. Use a loopback URL for live verification, or a local file URL only for static preview opens.";
    case "SHARED_DESKTOP_PATH_DISALLOWED":
      return "Planner model routed a \"my desktop\" request into the shared Public Desktop path.";
    case "LOCAL_ORGANIZATION_SHELL_ACTION_REQUIRED":
      return "Planner model did not include a real folder-move step for this local organization request. Retry the move in the same plan instead of stopping after inspection, folder creation, or holder cleanup.";
    case "LOCAL_ORGANIZATION_PROOF_REQUIRED":
      return "Planner model retried the local organization move without also proving what moved into the destination and what remained at the original root. Keep bounded move proof in the same plan.";
    case "LOCAL_ORGANIZATION_DESTINATION_SELF_MATCH_DISALLOWED":
      return "Planner model selected the named destination folder as part of the same move set, which risks nesting the destination inside itself. Exclude the destination explicitly before moving matching folders.";
    case "WINDOWS_ORGANIZATION_REQUIRES_POWERSHELL":
      return "Planner model used cmd-style shell moves for a Windows PowerShell organization request. Use PowerShell-native move commands instead.";
    case "WINDOWS_ORGANIZATION_INVALID_POWERSHELL_INTERPOLATION":
      return "Planner model used invalid PowerShell variable interpolation for a Windows organization move command. Use ${name} or string concatenation instead of raw $name: fragments.";
    case "BROAD_PROCESS_SHUTDOWN_DISALLOWED":
      return "Planner model attempted broad process-name shutdown as a recovery step. Use exact tracked stop_process actions, holder inspection, or clarification instead.";
    case "CANDIDATE_HOLDER_SHUTDOWN_REQUIRES_INSPECTION":
      return "Planner model attempted to stop candidate preview holders before inspection proved they were the exact blocker. Inspect first or clarify instead.";
    case "WORKSPACE_RECOVERY_RUNTIME_INSPECTION_REQUIRED":
      return "Planner model used ad-hoc shell lock inspection or skipped runtime inspection for an autonomous workspace-recovery step. Use inspect_workspace_resources or inspect_path_holders instead of handle/openfiles shell scripts.";
    case "WORKSPACE_RECOVERY_EXACT_PATH_INSPECTION_REQUIRED":
      return "Planner model did not inspect the exact blocked folder paths from the workspace-recovery request. Inspect those exact paths or use inspect_workspace_resources with the precise tracked selectors.";
    case "WORKSPACE_RECOVERY_STOP_OR_MOVE_REQUIRED":
      return "Planner model did not include a narrow stop_process step or a real scoped move retry for the exact-holder workspace-recovery step.";
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

  const isOrganizationRequest = isLocalWorkspaceOrganizationRequest(currentUserRequest);
  const prefix = isOrganizationRequest
    ? repairMode
      ? "Repair must include at least one executable non-respond action because the current user request is a local workspace-organization goal."
      : "Current user request is a local workspace-organization goal. Include at least one executable non-respond action and do not replace the plan with guidance-only respond output."
    : repairMode
      ? "Repair must include at least one executable non-respond action because the current user request is an execution-style build goal."
      : "Current user request is an execution-style build goal. Include at least one executable non-respond action and do not replace the plan with guidance-only respond output.";
  const concreteExecutionClause =
    " Inspection-only actions such as read_file, list_directory, check_process, or stop_process do not satisfy this requirement by themselves.";
  const organizationClause = isOrganizationRequest
    ? " For bounded local folder organization, finite shell_command steps are allowed when they stay scoped to the clearly matching project folders and the named destination folder."
    : "";
  const organizationExclusionClause = isOrganizationRequest
    ? " If the named destination folder could also match the same source selector, explicitly exclude that destination from the move set before moving anything. Never move the destination into itself or create a nested destination folder."
    : "";
  const liveVerificationClause = isLiveVerificationBuildRequest(currentUserRequest)
    ? " For live verification goals, keep finite proof steps first and include at least one live verification action such as start_process, probe_port, probe_http, or verify_browser."
    : "";
  const browserVerificationClause = requiresBrowserVerificationBuildRequest(currentUserRequest)
    ? " When the request explicitly asks to verify the UI or homepage, include verify_browser after loopback readiness is proven."
    : "";
  const persistentBrowserOpenClause = requiresPersistentBrowserOpenBuildRequest(currentUserRequest)
    ? " When the request asks to leave the page open afterward, include open_browser as a final visible-browser step after the artifact is ready. If explicit browser verification was requested, open the page after that proof succeeds."
    : "";
  const desktopPathClause = /\bon\s+my\s+desktop\b/i.test(currentUserRequest)
    ? " When the user says \"my desktop\", do not substitute a shared Public Desktop path."
    : "";
  return ` ${prefix}${concreteExecutionClause}${organizationClause}${organizationExclusionClause}${liveVerificationClause}${browserVerificationClause}${persistentBrowserOpenClause}${desktopPathClause}`;
}
