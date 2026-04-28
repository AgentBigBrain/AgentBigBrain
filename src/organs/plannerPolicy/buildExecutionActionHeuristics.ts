/**
 * @fileoverview Shared action-shape heuristics for execution-style build-policy validation.
 */

import { ActionType, PlannedAction } from "../../core/types";
import {
  containsWorkspaceRecoveryInspectFirstMarker,
  containsWorkspaceRecoveryPostShutdownRetryMarker,
  containsWorkspaceRecoveryStopExactMarker
} from "../../core/autonomy/workspaceRecoveryCommandBuilders";
import { extractActiveRequestSegment } from "../../core/currentRequestExtraction";
import {
  PlannerExecutionEnvironmentContext,
  RequiredActionType
} from "./executionStyleContracts";
import { isExecutionStyleBuildRequest } from "./liveVerificationPolicy";
import { extractWorkspaceRecoveryBlockedFolderPaths } from "./workspaceRecoveryParsing";
import {
  hasFrameworkAppAdHocPreviewServer,
  hasFrameworkAppDirectoryOnlyReuseGuard,
  hasFrameworkAppNonInPlaceScaffoldRepair,
  hasFrameworkAppScaffoldAction,
  hasShellCommandExceedingMaxChars,
  hasUnsupportedOpenBrowserTarget
} from "./frameworkBuildActionHeuristics";

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
const WINDOWS_CMD_BATCH_PATTERN =
  /\bif\s+not\s+exist\b|%~[A-Za-z]+|%\w\b|\bfor\s+\/d\b|\bmove\b[\s\S]{0,20}&&|&&/i;
const NATURAL_ARTIFACT_EDIT_CONTEXT_PATTERN = /\bNatural artifact-edit follow-up:/i;
const NATURAL_ARTIFACT_EDIT_REQUEST_PATTERN =
  /\b(?:change|edit|update|replace|swap|revise|tweak|adjust|make)\b[\s\S]{0,80}\b(?:hero|header|homepage|landing page|page|site|slider|cta|call to action|section|image|copy|headline|button)\b/i;
const WINDOWS_POWERSHELL_SCOPED_VARIABLE_PREFIXES = new Set([
  "env",
  "global",
  "script",
  "private",
  "local",
  "using",
  "function"
]);
const WINDOWS_POWERSHELL_INVALID_INTERPOLATION_PATTERN = /\$([A-Za-z_][A-Za-z0-9_]*):/g;
const WINDOWS_POWERSHELL_STATIC_STRING_JOIN_PATTERN = /\[string\]::Join\s*\(/i;
const ORGANIZATION_MOVE_COMMAND_PATTERN =
  /\b(?:move-item|mv|move)\b/i;
const ORGANIZATION_MOVE_PROOF_COMMAND_PATTERN =
  /(?:\bMOVED_TO_DEST\b|\bMOVED_TARGETS:|\bMOVED:|\bDEST_CONTENTS:|\bDEST_CONTENT_MATCHES:|\bREMAINING_AT_DESKTOP\b|\bROOT_REMAINING_MATCHES:|\bFAILED:)/i;
const WORKSPACE_RECOVERY_EXTERNAL_INSPECTION_PATTERN =
  /\b(?:handle(?:64)?(?:\.exe)?|openfiles)\b/i;
/**
 * Evaluates whether an action is too weak to satisfy an execution-style build plan on its own.
 */
export function isInspectionOnlyBuildAction(action: PlannedAction): boolean {
  return BUILD_INSPECTION_ONLY_ACTION_TYPES.includes(action.type);
}

/**
 * Evaluates whether an action contributes explicit live-verification behavior.
 */
export function isLiveVerificationAction(action: PlannedAction): boolean {
  return LIVE_VERIFICATION_ACTION_TYPES.includes(action.type);
}

/**
 * Evaluates whether a local organization plan still includes a real folder-move step.
 */
export function hasOrganizationMoveAction(actions: readonly PlannedAction[]): boolean {
  return actions.some((action) => {
    if (action.type !== "shell_command") {
      return false;
    }
    const command =
      typeof action.params.command === "string" ? action.params.command.trim() : "";
    return ORGANIZATION_MOVE_COMMAND_PATTERN.test(command);
  });
}

/**
 * Evaluates whether a local organization plan contains bounded proof of what moved and what
 * remained after the move step.
 *
 * @param actions - Planned actions produced by the model.
 * @returns `true` when the plan includes either governed organization proof markers or explicit
 * destination/root verification.
 */
export function hasOrganizationMoveProofAction(
  actions: readonly PlannedAction[]
): boolean {
  return actions.some((action) => {
    if (action.type === "list_directory") {
      return true;
    }
    if (action.type !== "shell_command") {
      return false;
    }
    const command =
      typeof action.params.command === "string" ? action.params.command.trim() : "";
    return (
      ORGANIZATION_MOVE_COMMAND_PATTERN.test(command) &&
      ORGANIZATION_MOVE_PROOF_COMMAND_PATTERN.test(command)
    );
  });
}

/**
 * Evaluates whether the current request is the inspect-first autonomous workspace-recovery step.
 *
 * @param currentUserRequest - Active planner-facing request text.
 * @returns `true` when the request carries the inspect-first workspace-recovery marker.
 */
export function isWorkspaceRecoveryInspectInstruction(
  currentUserRequest: string
): boolean {
  return containsWorkspaceRecoveryInspectFirstMarker(currentUserRequest);
}

/**
 * Evaluates whether the current request is the exact-stop autonomous workspace-recovery step.
 *
 * @param currentUserRequest - Active planner-facing request text.
 * @returns `true` when the request carries the exact-stop workspace-recovery marker.
 */
export function isWorkspaceRecoveryExactStopInstruction(
  currentUserRequest: string
): boolean {
  return containsWorkspaceRecoveryStopExactMarker(currentUserRequest);
}

/**
 * Evaluates whether the current request is the bounded post-shutdown workspace-recovery retry.
 *
 * @param currentUserRequest - Active planner-facing request text.
 * @returns `true` when the request carries the post-shutdown workspace-recovery marker.
 */
export function isWorkspaceRecoveryPostShutdownRetryInstruction(
  currentUserRequest: string
): boolean {
  return containsWorkspaceRecoveryPostShutdownRetryMarker(currentUserRequest);
}

/**
 * Evaluates whether the plan includes a runtime-owned workspace inspection action.
 *
 * @param actions - Planned actions produced by the model.
 * @returns `true` when the plan includes inspect_workspace_resources or inspect_path_holders.
 */
export function hasWorkspaceRecoveryInspectionAction(
  actions: readonly PlannedAction[]
): boolean {
  return actions.some(
    (action) =>
      action.type === "inspect_workspace_resources" ||
      action.type === "inspect_path_holders"
  );
}

/**
 * Evaluates whether an inspect-first workspace-recovery plan stayed grounded on the exact blocked
 * folder paths already present in the recovery request.
 *
 * @param currentUserRequest - Active planner-facing request text.
 * @param actions - Planned actions produced by the model.
 * @returns `true` when the inspection plan ignores or mangles the blocked folder paths.
 */
export function hasInvalidWorkspaceRecoveryInspectionTargets(
  currentUserRequest: string,
  actions: readonly PlannedAction[]
): boolean {
  if (!isWorkspaceRecoveryInspectInstruction(currentUserRequest)) {
    return false;
  }
  const blockedFolderPaths = extractWorkspaceRecoveryBlockedFolderPaths(currentUserRequest);
  if (blockedFolderPaths.length === 0) {
    return false;
  }

  const expectedPaths = new Set(blockedFolderPaths.map((value) => value.trim()));
  const inspectedPaths = new Set<string>();
  let hasWorkspaceInspection = false;
  for (const action of actions) {
    if (action.type === "inspect_workspace_resources") {
      hasWorkspaceInspection = true;
      continue;
    }
    if (action.type !== "inspect_path_holders") {
      continue;
    }
    const targetPath =
      typeof action.params.path === "string" ? action.params.path.trim() : "";
    if (!targetPath || !expectedPaths.has(targetPath)) {
      return true;
    }
    inspectedPaths.add(targetPath);
  }

  return !hasWorkspaceInspection && inspectedPaths.size !== expectedPaths.size;
}

/**
 * Evaluates whether an inspect-first workspace-recovery step tried to use ad-hoc shell lock
 * tooling instead of the governed runtime inspection actions.
 *
 * @param currentUserRequest - Active planner-facing request text.
 * @param actions - Planned actions produced by the model.
 * @returns `true` when the plan relies on shell lock tooling such as handle/openfiles.
 */
export function hasUnsupportedWorkspaceRecoveryInspectionShellAction(
  currentUserRequest: string,
  actions: readonly PlannedAction[]
): boolean {
  if (!isWorkspaceRecoveryInspectInstruction(currentUserRequest)) {
    return false;
  }
  return actions.some((action) => {
    if (action.type !== "shell_command") {
      return false;
    }
    const command =
      typeof action.params.command === "string" ? action.params.command.trim() : "";
    return command.length > 0 && WORKSPACE_RECOVERY_EXTERNAL_INSPECTION_PATTERN.test(command);
  });
}

/**
 * Evaluates whether an exact-stop workspace-recovery step includes either a narrow stop_process
 * action or a real scoped move retry.
 *
 * @param actions - Planned actions produced by the model.
 * @returns `true` when the plan can advance exact-holder recovery.
 */
export function hasWorkspaceRecoveryExactStopOrMoveAction(
  actions: readonly PlannedAction[]
): boolean {
  return actions.some((action) => action.type === "stop_process") || hasOrganizationMoveAction(actions);
}

/**
 * Evaluates whether a Windows organization plan is trying to use cmd/batch semantics instead of
 * the runtime's PowerShell shell.
 */
export function hasUnsupportedWindowsOrganizationShellAction(
  currentUserRequest: string,
  actions: readonly PlannedAction[],
  executionEnvironment: PlannerExecutionEnvironmentContext | null
): boolean {
  const activeRequest = extractActiveRequestSegment(currentUserRequest).trim();
  if (
    !isExecutionStyleBuildRequest(activeRequest) &&
    !/\b(?:organize|move|group|gather|sort|clean up|put|collect|tidy)\b/i.test(activeRequest)
  ) {
    return false;
  }
  if (
    executionEnvironment?.platform !== "win32" ||
    executionEnvironment.shellKind !== "powershell"
  ) {
    return false;
  }

  return actions.some((action) => {
    if (action.type !== "shell_command") {
      return false;
    }
    const requestedShellKind =
      typeof action.params.requestedShellKind === "string"
        ? action.params.requestedShellKind.trim().toLowerCase()
        : "";
    const command =
      typeof action.params.command === "string" ? action.params.command.trim() : "";
    return requestedShellKind === "cmd" || WINDOWS_CMD_BATCH_PATTERN.test(command);
  });
}

/**
 * Evaluates whether a Windows PowerShell organization shell step uses invalid interpolation such
 * as `"failed:$name:..."`.
 */
export function hasInvalidWindowsOrganizationPowerShellInterpolation(
  currentUserRequest: string,
  actions: readonly PlannedAction[],
  executionEnvironment: PlannerExecutionEnvironmentContext | null
): boolean {
  const activeRequest = extractActiveRequestSegment(currentUserRequest).trim();
  if (
    !/\b(?:organize|move|group|gather|sort|clean up|put|collect|tidy)\b/i.test(activeRequest) ||
    executionEnvironment?.platform !== "win32" ||
    executionEnvironment.shellKind !== "powershell"
  ) {
    return false;
  }

  return actions.some((action) => {
    if (action.type !== "shell_command") {
      return false;
    }
    const command =
      typeof action.params.command === "string" ? action.params.command.trim() : "";
    if (command.length === 0) {
      return false;
    }

    const interpolationMatches = command.matchAll(
      WINDOWS_POWERSHELL_INVALID_INTERPOLATION_PATTERN
    );
    for (const match of interpolationMatches) {
      const variableName = match[1]?.trim().toLowerCase();
      if (!variableName) {
        continue;
      }
      if (WINDOWS_POWERSHELL_SCOPED_VARIABLE_PREFIXES.has(variableName)) {
        continue;
      }
      return true;
    }
    return false;
  });
}

/**
 * Evaluates whether a Windows PowerShell organization proof command uses static string joining.
 * `[string]::Join(...)` can throw when a proof collection is empty or null, so bounded move proof
 * should coerce lists with `@(...)` and use `-join` instead.
 */
export function hasUnsafeWindowsOrganizationPowerShellProofJoin(
  currentUserRequest: string,
  actions: readonly PlannedAction[],
  executionEnvironment: PlannerExecutionEnvironmentContext | null
): boolean {
  const activeRequest = extractActiveRequestSegment(currentUserRequest).trim();
  if (
    !/\b(?:organize|move|group|gather|sort|clean up|put|collect|tidy)\b/i.test(activeRequest) ||
    executionEnvironment?.platform !== "win32" ||
    executionEnvironment.shellKind !== "powershell"
  ) {
    return false;
  }

  return actions.some((action) => {
    if (action.type !== "shell_command") {
      return false;
    }
    const command =
      typeof action.params.command === "string" ? action.params.command.trim() : "";
    return (
      ORGANIZATION_MOVE_COMMAND_PATTERN.test(command) &&
      ORGANIZATION_MOVE_PROOF_COMMAND_PATTERN.test(command) &&
      WINDOWS_POWERSHELL_STATIC_STRING_JOIN_PATTERN.test(command)
    );
  });
}

/**
 * Evaluates whether the plan is a tracked artifact-edit follow-up that may reopen the current
 * preview after mutating the tracked file, rather than a full build/live-run request.
 */
export function isTrackedArtifactEditPreviewPlan(
  requiredActionType: RequiredActionType | null,
  currentUserRequest: string,
  fullExecutionInput: string,
  actions: readonly PlannedAction[]
): boolean {
  const hasWriteFileAction = actions.some((action) => action.type === "write_file");
  if (!hasWriteFileAction) {
    return false;
  }
  if (requiredActionType === "write_file") {
    return true;
  }
  return (
    NATURAL_ARTIFACT_EDIT_CONTEXT_PATTERN.test(fullExecutionInput) &&
    NATURAL_ARTIFACT_EDIT_REQUEST_PATTERN.test(currentUserRequest)
  );
}

export {
  hasFrameworkAppAdHocPreviewServer,
  hasFrameworkAppDirectoryOnlyReuseGuard,
  hasFrameworkAppNonInPlaceScaffoldRepair,
  hasFrameworkAppScaffoldAction,
  hasShellCommandExceedingMaxChars,
  hasUnsupportedOpenBrowserTarget
};
