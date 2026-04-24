/**
 * @fileoverview Deterministic bounded fallback actions for local workspace-organization requests.
 */

import { estimateActionCostUsd } from "../../core/actionCostPolicy";
import { extractActiveRequestSegment } from "../../core/currentRequestExtraction";
import { makeId } from "../../core/ids";
import { PlannedAction } from "../../core/types";
import { PlannerExecutionEnvironmentContext } from "./executionStyleContracts";
import { getPathModuleForPathValue } from "./frameworkPathSupport";
import { isLocalWorkspaceOrganizationRequest } from "./liveVerificationPolicy";

const SUPPORTED_LOCAL_ORGANIZATION_FALLBACK_SHELL_KINDS = new Set([
  "powershell",
  "pwsh"
]);
const DESTINATION_FOLDER_CALLED_PATTERN =
  /\bfolder called\s+["']?([A-Za-z0-9][A-Za-z0-9._ -]*?)(?=["']?(?:\s+(?:on|in|under)\b|[.?!,]|$))/i;
const DESTINATION_IMPLICIT_NAME_PATTERN =
  /\b(?:go|belongs?)\b[\s\S]{0,40}\b(?:in|into|under)\s+["']?([A-Za-z0-9][A-Za-z0-9._ -]*)["']?(?=\s+(?:on|in|under)\b|[.?!,]|$)/i;
const NAME_BEGINS_WITH_PREFIX_PATTERN =
  /\bname\s+beg(?:inning\s+(?:in|with)|ins?\s+with)\s+["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?/i;
const EARLIER_PROJECT_FOLDERS_PREFIX_PATTERN =
  /\b(?:the\s+)?earlier\s+([A-Za-z0-9][A-Za-z0-9._-]*)\s+project\s+folders\b/i;
const NAMED_PROJECT_FOLDERS_PREFIX_PATTERN =
  /\b(?:organize|move)\s+(?:the\s+)?([A-Za-z0-9][A-Za-z0-9._-]*)\s+project\s+folders\b/i;
const USER_DESKTOP_LOCATION_PATTERN = /\bmy\s+desktop\b/i;
const USER_DOCUMENTS_LOCATION_PATTERN = /\bmy\s+documents\b/i;
const USER_DOWNLOADS_LOCATION_PATTERN = /\bmy\s+downloads\b/i;

type SupportedLocalOrganizationFallbackShellKind = "powershell" | "pwsh";

/**
 * Escapes one value for safe single-quoted PowerShell embedding.
 *
 * @param value - Raw string value.
 * @returns Escaped PowerShell-safe value.
 */
function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Normalizes a requested destination folder down to a basename under the user-owned root.
 *
 * @param value - Raw destination folder wording.
 * @param rootPath - Concrete user-owned root path.
 * @returns Safe destination folder basename, or `null` when unusable.
 */
function normalizeDestinationFolderName(value: string, rootPath: string): string | null {
  const pathModule = getPathModuleForPathValue(rootPath);
  const normalized = value.trim().replace(/[\\\/]+$/, "");
  if (!normalized) {
    return null;
  }
  return pathModule.basename(normalized).trim() || null;
}

/**
 * Extracts the requested destination folder name from one organization request.
 *
 * @param currentUserRequest - Planner-facing request text.
 * @param rootPath - Concrete user-owned root path.
 * @returns Requested destination folder basename, or `null`.
 */
function extractRequestedDestinationFolderName(
  currentUserRequest: string,
  rootPath: string
): string | null {
  const activeRequest = extractActiveRequestSegment(currentUserRequest).trim();
  if (!activeRequest) {
    return null;
  }
  const explicitMatch = activeRequest.match(DESTINATION_FOLDER_CALLED_PATTERN);
  if (explicitMatch?.[1]) {
    return normalizeDestinationFolderName(explicitMatch[1], rootPath);
  }
  const implicitMatch = activeRequest.match(DESTINATION_IMPLICIT_NAME_PATTERN);
  if (implicitMatch?.[1]) {
    return normalizeDestinationFolderName(implicitMatch[1], rootPath);
  }
  return null;
}

/**
 * Extracts the bounded folder-name prefix selector from one organization request.
 *
 * @param currentUserRequest - Planner-facing request text.
 * @returns Requested folder-name prefix, or `null`.
 */
function extractRequestedOrganizationPrefix(currentUserRequest: string): string | null {
  const activeRequest = extractActiveRequestSegment(currentUserRequest).trim();
  const match = activeRequest.match(NAME_BEGINS_WITH_PREFIX_PATTERN);
  const earlierProjectFoldersMatch = activeRequest.match(
    EARLIER_PROJECT_FOLDERS_PREFIX_PATTERN
  );
  const namedProjectFoldersMatch = activeRequest.match(
    NAMED_PROJECT_FOLDERS_PREFIX_PATTERN
  );
  const prefix =
    match?.[1]?.trim() ??
    earlierProjectFoldersMatch?.[1]?.trim() ??
    namedProjectFoldersMatch?.[1]?.trim() ??
    "";
  return prefix.length > 0 ? prefix : null;
}

/**
 * Resolves which concrete user-owned root the organization request targets.
 *
 * @param currentUserRequest - Planner-facing request text.
 * @param executionEnvironment - Planner execution environment context.
 * @returns Concrete root path, or `null` when the request is not explicit enough.
 */
function resolveRequestedOrganizationRootPath(
  currentUserRequest: string,
  executionEnvironment: PlannerExecutionEnvironmentContext
): string | null {
  const activeRequest = extractActiveRequestSegment(currentUserRequest).trim();
  if (
    USER_DOCUMENTS_LOCATION_PATTERN.test(activeRequest) &&
    executionEnvironment.documentsPath
  ) {
    return executionEnvironment.documentsPath;
  }
  if (
    USER_DOWNLOADS_LOCATION_PATTERN.test(activeRequest) &&
    executionEnvironment.downloadsPath
  ) {
    return executionEnvironment.downloadsPath;
  }
  if (
    USER_DESKTOP_LOCATION_PATTERN.test(activeRequest) &&
    executionEnvironment.desktopPath
  ) {
    return executionEnvironment.desktopPath;
  }
  return null;
}

/**
 * Builds the bounded PowerShell command that creates the destination, moves exact matches, and
 * proves both destination contents and remaining root matches.
 *
 * @param params - Concrete command parameters.
 * @returns PowerShell command text.
 */
function buildLocalOrganizationPowerShellCommand(params: {
  rootPath: string;
  destinationPath: string;
  destinationFolderName: string;
  prefix: string;
}): string {
  const rootPath = escapePowerShellSingleQuoted(params.rootPath);
  const destinationPath = escapePowerShellSingleQuoted(params.destinationPath);
  const destinationFolderName = escapePowerShellSingleQuoted(params.destinationFolderName);
  const prefix = escapePowerShellSingleQuoted(params.prefix);
  return [
    `$root = '${rootPath}'`,
    `$destination = '${destinationPath}'`,
    `$destinationName = '${destinationFolderName}'`,
    `$prefix = '${prefix}'`,
    "if (-not (Test-Path -LiteralPath $destination)) {",
    "  New-Item -ItemType Directory -Path $destination -Force | Out-Null",
    "}",
    "$targets = @(Get-ChildItem -LiteralPath $root -Directory | Where-Object {",
    "  $_.Name.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) -and",
    "  $_.Name -ne $destinationName",
    "})",
    "$targetNames = @($targets | Sort-Object Name | Select-Object -ExpandProperty Name)",
    "if ($targets.Count -gt 0) {",
    "  $targets | ForEach-Object {",
    "    Move-Item -LiteralPath $_.FullName -Destination $destination -Force -ErrorAction Stop",
    "  }",
    "}",
    "Write-Output ('MOVED_TO_DEST=' + ($targetNames -join ','))",
    "Write-Output 'DEST_CONTENTS:'",
    "Get-ChildItem -LiteralPath $destination -Directory | Sort-Object Name | Select-Object -ExpandProperty Name",
    "Write-Output 'ROOT_REMAINING_MATCHES:'",
    "Get-ChildItem -LiteralPath $root -Directory |",
    "  Where-Object {",
    "    $_.Name.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) -and",
    "    $_.Name -ne $destinationName",
    "  } |",
    "  Sort-Object Name |",
    "  Select-Object -ExpandProperty Name"
  ].join("\n");
}

/**
 * Builds bounded deterministic fallback actions when a local workspace-organization request still
 * fails planner repair and the request is explicit enough to synthesize a safe move.
 *
 * @param requestContext - Conversation-aware request text.
 * @param executionEnvironment - Planner execution environment context.
 * @returns Bounded deterministic fallback actions, or an empty list when the request is not
 *   explicit enough to synthesize safely.
 */
export function buildDeterministicLocalOrganizationFallbackActions(
  requestContext: string,
  executionEnvironment: PlannerExecutionEnvironmentContext | null
): PlannedAction[] {
  if (
    !executionEnvironment ||
    !SUPPORTED_LOCAL_ORGANIZATION_FALLBACK_SHELL_KINDS.has(executionEnvironment.shellKind) ||
    executionEnvironment.platform !== "win32"
  ) {
    return [];
  }

  const activeRequest = extractActiveRequestSegment(requestContext).trim();
  if (!isLocalWorkspaceOrganizationRequest(activeRequest)) {
    return [];
  }

  const rootPath = resolveRequestedOrganizationRootPath(activeRequest, executionEnvironment);
  if (!rootPath) {
    return [];
  }

  const destinationFolderName = extractRequestedDestinationFolderName(activeRequest, rootPath);
  const prefix = extractRequestedOrganizationPrefix(activeRequest);
  if (!destinationFolderName || !prefix) {
    return [];
  }

  const pathModule = getPathModuleForPathValue(rootPath);
  const destinationPath = pathModule.join(rootPath.replace(/[\\\/]+$/, ""), destinationFolderName);
  const requestedShellKind =
    executionEnvironment.shellKind as SupportedLocalOrganizationFallbackShellKind;
  const command = buildLocalOrganizationPowerShellCommand({
    rootPath,
    destinationPath,
    destinationFolderName,
    prefix
  });

  return [
    {
      id: makeId("action"),
      type: "shell_command",
      description:
        "Create the named destination if needed, move only the matching folders, and prove what landed in the destination and what remains at the original root.",
      params: {
        command,
        cwd: rootPath,
        workdir: rootPath,
        requestedShellKind,
        timeoutMs: 30_000
      },
      estimatedCostUsd: estimateActionCostUsd({
        type: "shell_command",
        params: {
          command,
          cwd: rootPath
        }
      })
    }
  ];
}
