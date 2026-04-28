/**
 * @fileoverview Deterministic workspace-recovery grounding snippets for planner prompt assembly.
 */

const WORKSPACE_RECOVERY_CONTEXT_PATTERN = /workspace recovery context for this chat:/i;
const WORKSPACE_RECOVERY_INSPECT_MARKER_PATTERN = /\[WORKSPACE_RECOVERY_INSPECT_FIRST\]/i;
const WORKSPACE_RECOVERY_STOP_MARKER_PATTERN = /\[WORKSPACE_RECOVERY_STOP_EXACT\]/i;
const WORKSPACE_RECOVERY_POST_SHUTDOWN_RETRY_MARKER_PATTERN =
  /\[WORKSPACE_RECOVERY_POST_SHUTDOWN_RETRY\]/i;
const WORKSPACE_RECOVERY_BLOCKED_PATHS_PATTERN = /blocked folder paths:\s*([^\n]+)/i;
const PREFERRED_WORKSPACE_ROOT_PATTERN = /preferred workspace root:\s*([^\n]+)/i;
const PREFERRED_PREVIEW_URL_PATTERN = /preferred preview url:\s*([^\n]+)/i;
const EXACT_BROWSER_SESSION_IDS_PATTERN = /exact tracked browser session ids:\s*([^\n]+)/i;
const EXACT_PREVIEW_LEASE_IDS_PATTERN = /exact tracked preview lease ids:\s*([^\n]+)/i;
const NO_EXACT_TRACKED_WORKSPACE_HOLDER_PATTERN =
  /no exact tracked workspace holder is currently known for this request/i;
const STRUCTURED_RECOVERY_OPTION_PATTERN =
  /\[STRUCTURED_RECOVERY_OPTION:([a-z0-9_]+)\]/i;
const STRUCTURED_RECOVERY_CWD_PATTERN = /Preferred repair cwd:\s*([^\n]+)/i;
const STRUCTURED_RECOVERY_FAILED_COMMAND_PATTERN = /Original failed command:\s*([^\n]+)/i;
const STRUCTURED_RECOVERY_RECOMMENDED_COMMAND_PATTERN =
  /Recommended narrow repair command:\s*([^\n]+)/i;
const STRUCTURED_RECOVERY_DEPENDENCY_PATTERN =
  /(?:Detected missing dependency|Detected incompatibility hint):\s*([^\n]+)/i;

/**
 * Reads one single-line field value from the planner-facing request context.
 *
 * @param pattern - Regex that captures one single-line value.
 * @param currentUserRequest - Full planner-facing request body.
 * @returns The trimmed captured value, or `null` when absent.
 */
function readSingleLineValue(pattern: RegExp, currentUserRequest: string): string | null {
  const match = currentUserRequest.match(pattern);
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : null;
}

/**
 * Builds deterministic planner guidance from the workspace-recovery context already present in the request.
 *
 * @param currentUserRequest - Current planner-facing request body.
 * @returns Recovery grounding guidance, or an empty string when no workspace-recovery block exists.
 */
export function buildWorkspaceRecoveryActionPolicyGuidance(
  currentUserRequest: string
): string {
  const hasWorkspaceRecoveryContext = WORKSPACE_RECOVERY_CONTEXT_PATTERN.test(currentUserRequest);
  const inspectFirstMarker = WORKSPACE_RECOVERY_INSPECT_MARKER_PATTERN.test(currentUserRequest);
  const exactStopMarker = WORKSPACE_RECOVERY_STOP_MARKER_PATTERN.test(currentUserRequest);
  const postShutdownRetryMarker =
    WORKSPACE_RECOVERY_POST_SHUTDOWN_RETRY_MARKER_PATTERN.test(currentUserRequest);
  if (
    !hasWorkspaceRecoveryContext &&
    !inspectFirstMarker &&
    !exactStopMarker &&
    !postShutdownRetryMarker &&
    !STRUCTURED_RECOVERY_OPTION_PATTERN.test(currentUserRequest)
  ) {
    return "";
  }

  const workspaceRoot = readSingleLineValue(
    PREFERRED_WORKSPACE_ROOT_PATTERN,
    currentUserRequest
  );
  const previewUrl = readSingleLineValue(
    PREFERRED_PREVIEW_URL_PATTERN,
    currentUserRequest
  );
  const browserSessionIds = readSingleLineValue(
    EXACT_BROWSER_SESSION_IDS_PATTERN,
    currentUserRequest
  );
  const previewLeaseIds = readSingleLineValue(
    EXACT_PREVIEW_LEASE_IDS_PATTERN,
    currentUserRequest
  );
  const blockedFolderPaths = readSingleLineValue(
    WORKSPACE_RECOVERY_BLOCKED_PATHS_PATTERN,
    currentUserRequest
  );

  const parts = [
    "The current request context already contains workspace-recovery facts from the runtime. Reuse those exact facts instead of inventing process-name or path-token recovery."
  ];
  if (inspectFirstMarker) {
    parts.push(
      "This is the inspect-first workspace-recovery step. Your main non-respond action must include inspect_workspace_resources or inspect_path_holders. list_directory alone is not enough for this step."
    );
  }
  if (exactStopMarker) {
    parts.push(
      "This is the exact-holder shutdown workspace-recovery step. Prefer stop_process for the proven exact tracked lease ids, then retry the move in the same plan or the next bounded retry."
    );
  }
  if (postShutdownRetryMarker) {
    parts.push(
      "This is the post-shutdown workspace-recovery retry step. Keep the move scoped, and prove the result in the same plan with destination/root verification or bounded shell output markers such as MOVED_TO_DEST=..., DEST_CONTENTS=..., and ROOT_REMAINING_MATCHES=...."
    );
    parts.push(
      "For PowerShell proof markers, assign destination/root proof lists with @(...), join them with -join, and print empty markers when a list is empty instead of calling [string]::Join on nullable pipeline output."
    );
  }
  if (blockedFolderPaths && blockedFolderPaths !== "none") {
    parts.push(
      `Prefer these exact blocked folder paths when you inspect holders or verify retries: ${blockedFolderPaths}.`
    );
  }
  if (workspaceRoot && workspaceRoot !== "unknown") {
    parts.push(
      `Prefer the tracked workspace root ${workspaceRoot} when you inspect workspace resources or verify post-move results.`
    );
  }
  if (previewUrl && previewUrl !== "none") {
    parts.push(
      `Prefer the tracked preview URL ${previewUrl} when a preview reference is needed for inspect, open, or close behavior.`
    );
  }
  if (browserSessionIds && browserSessionIds !== "none") {
    parts.push(
      `If browser control is needed, prefer these exact tracked browser session ids: ${browserSessionIds}.`
    );
  }
  if (NO_EXACT_TRACKED_WORKSPACE_HOLDER_PATTERN.test(currentUserRequest)) {
    parts.push(
      "The current context explicitly says no exact tracked workspace holder is known yet. Candidate preview leases from this context are inspection hints only, not automatic shutdown proof."
    );
    parts.push(
      "Do not emit stop_process for candidate-only preview leases until inspect_workspace_resources or inspect_path_holders proves the exact blocker. If inspection still leaves only likely holders, clarify before shutdown."
    );
  }
  if (previewLeaseIds && previewLeaseIds !== "none") {
    parts.push(
      `If process control is needed, prefer these exact tracked preview lease ids: ${previewLeaseIds}. Stop only those exact lease ids when inspection proves they still hold the workspace.`
    );
  } else {
    parts.push(
      "If exact tracked preview lease ids are absent, inspect first and clarify before touching untracked processes."
    );
  }
  parts.push(
    "Do not ignore exact runtime ids from the request context and replace them with broad process-name shutdown."
  );
  const structuredRecoveryOption = readSingleLineValue(
    STRUCTURED_RECOVERY_OPTION_PATTERN,
    currentUserRequest
  );
  if (structuredRecoveryOption) {
    const repairCwd = readSingleLineValue(
      STRUCTURED_RECOVERY_CWD_PATTERN,
      currentUserRequest
    );
    const failedCommand = readSingleLineValue(
      STRUCTURED_RECOVERY_FAILED_COMMAND_PATTERN,
      currentUserRequest
    );
    const recommendedCommand = readSingleLineValue(
      STRUCTURED_RECOVERY_RECOMMENDED_COMMAND_PATTERN,
      currentUserRequest
    );
    const dependencyHint = readSingleLineValue(
      STRUCTURED_RECOVERY_DEPENDENCY_PATTERN,
      currentUserRequest
    );
    parts.push(
      `This request is a structured bounded recovery iteration for option ${structuredRecoveryOption}. Keep the plan narrow and recovery-shaped.`
    );
    if (repairCwd) {
      parts.push(`Prefer the repair cwd ${repairCwd} for any bounded shell or manifest step.`);
    }
    if (failedCommand) {
      parts.push(`After the bounded repair, rerun exactly this failed command once: ${failedCommand}.`);
    }
    if (recommendedCommand) {
      parts.push(`Prefer this existing deterministic repair command when policy allows it: ${recommendedCommand}.`);
    }
    if (dependencyHint) {
      parts.push(`Only repair the named dependency or incompatibility hint: ${dependencyHint}.`);
    }
    if (
      structuredRecoveryOption === "repair_missing_dependency" ||
      structuredRecoveryOption === "align_dependency_version"
    ) {
      parts.push(
        "Do not broaden this repair into npm update, yarn upgrade, pnpm up, bun update, audit-fix, full reinstall, scaffold reset, or unrelated dependency cleanup."
      );
    }
  }
  return `\nDeterministic workspace recovery grounding: ${parts.join(" ")}`;
}
