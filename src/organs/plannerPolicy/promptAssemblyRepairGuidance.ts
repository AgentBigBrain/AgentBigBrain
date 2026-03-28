/**
 * @fileoverview Deterministic repair-guidance snippets for planner prompt assembly.
 */

/**
 * Appends deterministic repair guidance for invalid planner action plans.
 *
 * @param repairReason - Machine-readable repair reason emitted by planner validation.
 * @returns Additional prompt text describing how the repaired plan should change.
 */
export function buildPlannerRepairReasonGuidance(repairReason: string): string {
  if (
    repairReason.startsWith("invalid_execution_style_build_plan:FRAMEWORK_APP_SCAFFOLD_ACTION_REQUIRED")
  ) {
    return (
      " The prior plan failed because it treated a fresh framework-app request like an already-ready workspace. " +
      "Repair by including at least one real scaffold or bootstrap step that can materialize package.json in the exact workspace, such as create-next-app/create-vite, a bounded temp-slug scaffold merge, or an explicit package.json bootstrap or repair step in the target folder. " +
      "Generic npm install, npm run build, npm run dev, or npm run start commands do not satisfy this by themselves when package.json is not already proven present."
    );
  }
  if (
    repairReason.startsWith("invalid_execution_style_build_plan:FRAMEWORK_APP_ARTIFACT_CHECK_REQUIRED")
  ) {
    return (
      " The prior plan failed because it treated folder existence alone as proof the framework app already exists. " +
      "Repair by checking for real scaffold artifacts such as package.json before deciding to reuse or skip scaffold. " +
      "If the folder exists but package.json is missing, complete the scaffold or repair in place instead of assuming the app is ready."
    );
  }
  if (
    repairReason.startsWith("invalid_execution_style_build_plan:FRAMEWORK_APP_IN_PLACE_SCAFFOLD_REQUIRED")
  ) {
    return (
      " The prior plan failed because it checked the exact folder for package.json but still tried to recreate that folder from the parent directory. " +
      "Repair by scaffolding or repairing in place inside the exact requested folder when package.json is missing, for example by setting the cwd to that folder and using '.' as the scaffold target. " +
      "If that exact folder already contains Vite-like source files such as index.html, src/main.jsx, src/App.jsx, or src/index.css, prefer repairing the workspace in place by writing the missing package.json and any standard Vite metadata before install/build instead of rerunning create-vite. " +
      "Do not rerun create-vite or similar against the folder name from outside that folder."
    );
  }
  if (
    repairReason.startsWith(
      "invalid_execution_style_build_plan:FRAMEWORK_APP_PACKAGE_SAFE_SCAFFOLD_REQUIRED"
    )
  ) {
    return (
      " The prior plan failed because it fed the exact requested human-facing folder name into a create-style scaffold even though that name is not a safe npm package name. " +
      "Repair by preserving the exact requested folder for the final workspace, but scaffold through a package-safe lowercase slug instead, then move the generated contents into the exact requested folder. " +
      "Continue install/build/run from the exact requested folder after the move. " +
      "Do not run create-next-app, create-vite, or similar directly against the unsafe exact folder name, and do not rely on '.' inside that unsafe exact folder."
    );
  }
  if (
    repairReason.startsWith("invalid_execution_style_build_plan:FRAMEWORK_APP_NATIVE_PREVIEW_REQUIRED")
  ) {
    return (
      " The prior plan failed because it used an ad-hoc preview server for a framework-app live-run request. " +
      "Repair by starting the app with the workspace-native preview/runtime command instead, such as npm run preview, npm run dev, vite preview, or vite dev from the exact project folder. " +
      "Keep the later readiness probe and open_browser actions pointed at that same loopback URL so the runtime can leave the correct app open and later stop it cleanly."
    );
  }
  if (
    repairReason.startsWith("invalid_execution_style_build_plan:SHELL_COMMAND_MAX_CHARS_EXCEEDED")
  ) {
    return (
      " The prior plan failed because one shell or start-process command exceeded the runtime's command-length budget. " +
      "Repair by splitting large inline file creation into separate write_file actions and keeping shell/toolchain steps short and bounded, such as separate npm install, npm run build, and npm run preview commands instead of one giant script."
    );
  }
  if (repairReason.startsWith("invalid_execution_style_build_plan:LIVE_VERIFICATION_ACTION_REQUIRED")) {
    return (
      " The prior plan failed because it omitted live-verification actions. " +
      "Repair by returning one action list that contains the complete local proof chain needed to finish truthfully: " +
      "start_process when a local server is required, then probe_port or probe_http for loopback readiness, " +
      "and verify_browser when the request asks for UI or homepage verification. " +
      "Do not return helper-file creation by itself as the repaired plan."
    );
  }
  if (repairReason.startsWith("invalid_execution_style_build_plan:START_PROCESS_REQUIRES_PROOF_ACTION")) {
    return (
      " The prior plan failed because it started a process without also planning the required proof steps. " +
      "Repair by keeping start_process and adding loopback readiness proof with probe_port or probe_http, " +
      "plus verify_browser whenever the request explicitly asks for UI verification."
    );
  }
  if (repairReason.startsWith("invalid_execution_style_build_plan:BROWSER_VERIFICATION_ACTION_REQUIRED")) {
    return (
      " The prior plan failed because it omitted verify_browser for an explicit UI verification request. " +
      "Repair by adding verify_browser after readiness proof in the same action list."
    );
  }
  if (repairReason.startsWith("invalid_execution_style_build_plan:PERSISTENT_BROWSER_OPEN_REQUIRED")) {
    return (
      " The prior plan failed because it omitted open_browser for a request that explicitly asked to leave the page open. " +
      "Repair by adding open_browser after verification succeeds. " +
      "Reuse the exact local target that the plan really proved ready: the verified loopback URL for live runs, or the built local file:// artifact for static previews."
    );
  }
  if (repairReason.startsWith("invalid_execution_style_build_plan:OPEN_BROWSER_HTTP_URL_REQUIRED")) {
    return (
      " The prior plan failed because open_browser used a target that does not match this request. " +
      "Repair by using a loopback http URL when live verification is required, or an absolute local file:// URL when the request only needs a visible static preview."
    );
  }
  if (repairReason.startsWith("invalid_execution_style_build_plan:SHARED_DESKTOP_PATH_DISALLOWED")) {
    return (
      " The prior plan failed because it used a shared Public Desktop path for a request that explicitly said \"my desktop.\" " +
      "Repair by using the concrete user-owned Desktop path from the execution environment guidance."
    );
  }
  if (
    repairReason.startsWith("invalid_execution_style_build_plan:LOCAL_ORGANIZATION_SHELL_ACTION_REQUIRED")
  ) {
    return (
      " The prior plan failed because it stopped at inspection or holder cleanup without retrying the actual folder move. " +
      "Repair by including a real shell_command that creates the destination folder if needed and retries the scoped move in the same plan, then verify both the destination and the original root."
    );
  }
  if (
    repairReason.startsWith("invalid_execution_style_build_plan:LOCAL_ORGANIZATION_PROOF_REQUIRED")
  ) {
    return (
      " The prior plan failed because it retried the folder move without bounded proof of what actually moved. " +
      "Repair by keeping the scoped move and also proving the outcome in the same plan, either by adding explicit list_directory verification for the destination and original root or by emitting governed shell output markers such as MOVED_TO_DEST / REMAINING_AT_DESKTOP or DEST_CONTENTS / ROOT_REMAINING_MATCHES."
    );
  }
  if (
    repairReason.startsWith(
      "invalid_execution_style_build_plan:LOCAL_ORGANIZATION_DESTINATION_SELF_MATCH_DISALLOWED"
    )
  ) {
    return (
      " The prior plan failed because its move selector also matched the named destination folder, which risks moving the destination into itself and creating a nested folder. " +
      "Repair by excluding the destination explicitly from the source filter before Move-Item runs, then verify that only the matching source folders moved into the destination."
    );
  }
  if (
    repairReason.startsWith("invalid_execution_style_build_plan:WINDOWS_ORGANIZATION_REQUIRES_POWERSHELL")
  ) {
    return (
      " The prior plan failed because it used cmd-style folder-move commands for a Windows PowerShell organization request. " +
      "Repair by using PowerShell-native syntax only, for example Test-Path, New-Item, Get-ChildItem, Where-Object, and Move-Item, and keep the move scoped to the matching project folders."
    );
  }
  if (
    repairReason.startsWith(
      "invalid_execution_style_build_plan:WINDOWS_ORGANIZATION_INVALID_POWERSHELL_INTERPOLATION"
    )
  ) {
    return (
      " The prior plan failed because it used invalid PowerShell string interpolation in a Windows organization command. " +
      "Repair by avoiding raw variable fragments like \"$name:\" inside double-quoted strings. " +
      "Use ${name}, subexpressions like $($name), or string concatenation instead."
    );
  }
  if (
    repairReason.startsWith("invalid_execution_style_build_plan:BROAD_PROCESS_SHUTDOWN_DISALLOWED")
  ) {
    return (
      " The prior plan failed because it tried to recover by stopping broad apps by process name. " +
      "Repair by doing this instead: use exact tracked stop_process actions when a lease id is known. If the holder is not proven, inspect or clarify instead. " +
      "Do not emit Stop-Process -Name, taskkill /IM, pkill, killall, or similar broad process-name shutdown commands."
    );
  }
  if (
    repairReason.startsWith("invalid_execution_style_build_plan:CANDIDATE_HOLDER_SHUTDOWN_REQUIRES_INSPECTION")
  ) {
    return (
      " The prior plan failed because it treated candidate preview-holder hints as if they were exact shutdown proof. " +
      "Repair by inspecting first with inspect_workspace_resources or inspect_path_holders. " +
      "Only emit stop_process after inspection proves exact tracked holders. If the result still leaves only likely holders, ask for clarification before shutdown."
    );
  }
  if (
    repairReason.startsWith("invalid_execution_style_build_plan:WORKSPACE_RECOVERY_RUNTIME_INSPECTION_REQUIRED")
  ) {
    return (
      " The prior plan failed because this autonomous workspace-recovery step must stay on the governed runtime inspection tools, not ad-hoc shell lock scripts. " +
      "Repair by using inspect_workspace_resources or inspect_path_holders first. " +
      "Do not use handle.exe, handle64.exe, openfiles, or similar shell-based holder inspection commands for this step."
    );
  }
  if (
    repairReason.startsWith(
      "invalid_execution_style_build_plan:WORKSPACE_RECOVERY_EXACT_PATH_INSPECTION_REQUIRED"
    )
  ) {
    return (
      " The prior plan failed because it did not inspect the exact blocked folder paths from the recovery request. " +
      "Repair by inspecting each exact blocked folder path already listed in the request, or use inspect_workspace_resources with the precise tracked selectors from the runtime context. " +
      "Do not turn the surrounding instruction prose into extra inspect_path_holders paths."
    );
  }
  if (
    repairReason.startsWith("invalid_execution_style_build_plan:WORKSPACE_RECOVERY_STOP_OR_MOVE_REQUIRED")
  ) {
    return (
      " The prior plan failed because the exact-holder recovery step did not actually advance the recovery. " +
      "Repair by either stopping the exact tracked holder with stop_process or retrying the scoped folder move if that holder was already cleared. " +
      "Do not replace this step with guidance-only respond output."
    );
  }
  if (repairReason.startsWith("missing_linked_preview_stop_process:")) {
    return (
      " The prior plan failed because it closed the tracked browser window without stopping the linked local preview process. " +
      "Repair by keeping close_browser for the tracked session and adding stop_process with params.leaseId set to the linked preview lease from the current request context."
    );
  }
  return "";
}
