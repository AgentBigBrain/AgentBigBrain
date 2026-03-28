/**
 * @fileoverview Human-facing messaging helpers for execution-style build-plan policy.
 */

import { ExecutionStyleBuildPlanIssueCode } from "./executionStyleContracts";
import {
  extractRequestedFrameworkFolderName,
  isFrameworkPackageSafeFolderName,
  toFrameworkPackageSafeSlug
} from "./frameworkBuildActionHeuristics";
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
    case "FRAMEWORK_APP_SCAFFOLD_ACTION_REQUIRED":
      return "Planner model treated a fresh framework-app request like an already-ready workspace. Include a real scaffold or bootstrap step that can materialize package.json in the exact workspace, such as create-next-app/create-vite or an explicit package.json bootstrap or temp-slug merge. Generic install/build/start commands alone are not enough.";
    case "FRAMEWORK_APP_ARTIFACT_CHECK_REQUIRED":
      return "Planner model treated directory existence alone as proof a framework app already exists. Reuse or skip scaffold only after checking for real app artifacts such as package.json; otherwise repair or scaffold in place.";
    case "FRAMEWORK_APP_IN_PLACE_SCAFFOLD_REQUIRED":
      return "Planner model checked for package.json but still tried to recreate the named framework-app folder from its parent directory. When package.json is missing, scaffold or repair inside the exact requested folder instead of recreating the folder name from outside it.";
    case "FRAMEWORK_APP_PACKAGE_SAFE_SCAFFOLD_REQUIRED":
      return "Planner model fed the exact requested folder name into a create-style framework scaffold even though that human-facing folder name is not a safe npm package name. Preserve the requested folder for the workspace, but scaffold through a package-safe slug and move the generated contents into the exact requested folder.";
    case "FRAMEWORK_APP_NATIVE_PREVIEW_REQUIRED":
      return "Planner model chose an ad-hoc preview server for a framework-app live-run request. Use the workspace-native preview/runtime command such as npm run preview, npm run dev, or vite preview/dev so the runtime can prove and later stop the same app cleanly.";
    case "SHELL_COMMAND_MAX_CHARS_EXCEEDED":
      return "Planner model emitted a shell or start-process command longer than the configured runtime command budget. Split large inline file writes into write_file actions and keep shell/toolchain steps short enough for the current shell runtime.";
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
  const frameworkScaffoldClause =
    /\b(?:react|vite|next\.?js|nextjs|vue|svelte|angular)\b/i.test(currentUserRequest)
      ? " For a fresh framework-app request, raw source-file writes alone do not satisfy the build. Include at least one real scaffold/build-capable action such as npm/npx/pnpm/yarn/bun create, install, build, dev, start, or preview. If you may reuse an existing folder, key that decision off real scaffold artifacts like package.json instead of only checking whether the directory exists. When package.json is missing for the exact requested folder, scaffold or repair in place inside that folder instead of recreating the folder name from its parent directory. If that exact folder already contains Vite-like source files such as index.html or src/main.jsx but still lacks package.json, prefer repairing it in place by writing the missing package.json and standard Vite metadata before install/build. Once the exact project folder is known, set cwd/workdir to that folder and run npm install / npm run build / npm run preview there instead of chaining multi-step --prefix commands from the parent directory."
      : "";
  const requestedFrameworkFolderName = extractRequestedFrameworkFolderName(currentUserRequest);
  const frameworkPackageSafeClause =
    requestedFrameworkFolderName &&
    !isFrameworkPackageSafeFolderName(requestedFrameworkFolderName)
      ? ` The exact requested folder name "${requestedFrameworkFolderName}" is not a safe npm package name. Preserve that exact folder for the user-facing workspace, but do not feed it directly into create-style scaffolds such as create-next-app or create-vite. Use a package-safe slug such as "${toFrameworkPackageSafeSlug(requestedFrameworkFolderName)}" for the scaffold step, then move the generated contents into the exact requested folder and continue install/build/run from that exact folder.`
      : "";
  const liveVerificationClause = isLiveVerificationBuildRequest(currentUserRequest)
    ? " For live verification goals, keep finite proof steps first and include at least one live verification action such as start_process, probe_port, probe_http, or verify_browser."
    : "";
  const frameworkLivePreviewClause =
    /\b(?:react|vite|next\.?js|nextjs|vue|svelte|angular)\b/i.test(currentUserRequest) &&
    isLiveVerificationBuildRequest(currentUserRequest)
      ? " For framework-app live runs, prefer the workspace-native preview/runtime command such as npm run preview, npm run dev, vite preview, or vite dev instead of inventing an ad-hoc npx serve server."
      : "";
  const commandBudgetClause =
    /\b(?:react|vite|next\.?js|nextjs|vue|svelte|angular)\b/i.test(currentUserRequest)
      ? " Keep large file content in write_file actions instead of one oversized shell script so the toolchain commands stay within the runtime command-length budget."
      : "";
  const browserVerificationClause = requiresBrowserVerificationBuildRequest(currentUserRequest)
    ? " When the request explicitly asks to verify the UI or homepage, include verify_browser after loopback readiness is proven."
    : "";
  const persistentBrowserOpenClause = requiresPersistentBrowserOpenBuildRequest(currentUserRequest)
    ? " When the request asks to leave the page open afterward, include open_browser as a final visible-browser step after the artifact is ready. If explicit browser verification was requested, open the page after that proof succeeds. For framework apps, point open_browser at the same verified loopback URL or built local artifact that this plan actually proved ready."
    : "";
  const desktopPathClause = /\bon\s+my\s+desktop\b/i.test(currentUserRequest)
    ? " When the user says \"my desktop\", do not substitute a shared Public Desktop path."
    : "";
  return ` ${prefix}${concreteExecutionClause}${organizationClause}${organizationExclusionClause}${frameworkScaffoldClause}${frameworkPackageSafeClause}${liveVerificationClause}${frameworkLivePreviewClause}${commandBudgetClause}${browserVerificationClause}${persistentBrowserOpenClause}${desktopPathClause}`;
}
