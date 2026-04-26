/**
 * @fileoverview Bounded blocked-path parsing helpers for workspace-lock recovery.
 */

import { readdirSync } from "node:fs";
import path from "node:path";

import { dirnameCrossPlatformPath } from "../crossPlatformPath";
import type { ActionRunResult, TaskRunResult } from "../types";

const LOCAL_FOLDER_IN_USE_PATTERN =
  /the process cannot access the file because it is being used by another process\./i;
const POWERSHELL_FAILED_PATH_PATTERN = /WriteError:\s*\((.+?):DirectoryInfo\)/gi;
const POWERSHELL_FORMAT_LIST_PATH_PATTERN = /^\s*Path\s*:\s*(.+)$/gim;
const WINDOWS_PATH_LINE_PATTERN = /^[A-Za-z]:\\[^\r\n]+$/gm;

/**
 * Reads one JSON payload from mixed shell output when the command wrapped structured diagnostics.
 *
 * @param output - Shell output or result text.
 * @returns Parsed JSON payload, or `null` when none can be recovered safely.
 */
function readJsonPayloadFromOutput(output: string): unknown | null {
  const trimmed = output.trim();
  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart < 0 || objectEnd <= objectStart) {
    return null;
  }
  const candidate = trimmed.slice(objectStart, objectEnd + 1);
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
}

/**
 * Resolves the current user-owned Desktop path from the local environment.
 *
 * @returns Desktop path rooted in OneDrive, `USERPROFILE`, or `HOME`, or `null` when none exist.
 */
function resolveDesktopPathFromEnvironment(): string | null {
  const oneDrive = process.env.OneDrive?.trim();
  if (oneDrive) {
    return path.join(oneDrive, "Desktop");
  }
  const userProfile = process.env.USERPROFILE?.trim();
  if (userProfile) {
    return path.join(userProfile, "Desktop");
  }
  const home = process.env.HOME?.trim();
  return home ? path.join(home, "Desktop") : null;
}

/**
 * Normalizes one blocked-path candidate into a concrete Desktop-rooted path where possible.
 *
 * @param candidate - Raw path-like or message-like candidate text.
 * @param blockedPaths - Output set collecting exact blocked paths.
 * @param desktopPath - Resolved Desktop path used for abbreviated folder reconstruction.
 */
function addBlockedPathCandidate(
  candidate: string,
  blockedPaths: Set<string>,
  desktopPath: string | null
): void {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return;
  }

  const messageLikeCandidate =
    desktopPath && !/^[A-Za-z]:\\/.test(trimmed) && trimmed.includes(":")
      ? trimmed.slice(0, trimmed.indexOf(":"))
      : trimmed;
  const normalizedCandidate = messageLikeCandidate.trim().replace(/[\\/]+$/, "");
  if (/^[A-Za-z]:\\/.test(normalizedCandidate) && !normalizedCandidate.includes("...")) {
    blockedPaths.add(normalizedCandidate);
    return;
  }

  const basename = path.win32.basename(normalizedCandidate);
  if (!basename || basename === "." || basename === "..") {
    return;
  }

  if (desktopPath && basename.includes("...")) {
    const matchSuffix = basename.replace(/^\.+/, "");
    if (matchSuffix) {
      try {
        const directoryMatches = readdirSync(desktopPath, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .filter((entryName) => entryName.endsWith(matchSuffix));
        if (directoryMatches.length === 1) {
          blockedPaths.add(path.join(desktopPath, directoryMatches[0]));
          return;
        }
      } catch {
        // Fall through to the generic desktop-root reconstruction below.
      }
    }
  }

  blockedPaths.add(desktopPath ? path.join(desktopPath, basename) : basename);
}

/**
 * Recursively recovers blocked folder paths from structured shell metadata.
 *
 * @param value - Unknown parsed JSON payload value.
 * @param output - Output set collecting exact blocked paths.
 * @param desktopPath - Resolved Desktop path used for abbreviated folder reconstruction.
 */
function collectBlockedFolderPathsFromUnknown(
  value: unknown,
  output: Set<string>,
  desktopPath: string | null
): void {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string" && desktopPath) {
        addBlockedPathCandidate(entry, output, desktopPath);
        continue;
      }
      collectBlockedFolderPathsFromUnknown(entry, output, desktopPath);
    }
    return;
  }
  const record = value as Record<string, unknown>;
  for (const [key, candidate] of Object.entries(record)) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey !== "sourcepath" &&
      normalizedKey !== "fullpath" &&
      normalizedKey !== "path" &&
      normalizedKey !== "folder" &&
      normalizedKey !== "name" &&
      normalizedKey !== "item"
    ) {
      continue;
    }
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      addBlockedPathCandidate(candidate, output, desktopPath);
    }
  }
  for (const [key, nestedValue] of Object.entries(record)) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey !== "failed" &&
      normalizedKey !== "blocked" &&
      normalizedKey !== "remaining" &&
      normalizedKey !== "items" &&
      normalizedKey !== "matchedbefore" &&
      normalizedKey !== "remainingondesktop" &&
      normalizedKey !== "remainingblockedpaths" &&
      normalizedKey !== "sourceremaining" &&
      normalizedKey !== "remainingsamplefoldersondesktop" &&
      normalizedKey !== "remainingsampleondesktop" &&
      normalizedKey !== "remainingsamplefolders" &&
      normalizedKey !== "remaininginsource" &&
      normalizedKey !== "remainingsampledirsondesktop"
    ) {
      continue;
    }
    collectBlockedFolderPathsFromUnknown(nestedValue, output, desktopPath);
  }
}

/**
 * Recovers blocked folder paths from unstructured shell stderr/stdout text.
 *
 * @param output - Shell output or result text.
 * @param blockedPaths - Output set collecting exact blocked paths.
 */
function collectBlockedFolderPathsFromShellOutput(
  output: string,
  blockedPaths: Set<string>
): void {
  const desktopPath = resolveDesktopPathFromEnvironment();
  for (const match of output.matchAll(POWERSHELL_FAILED_PATH_PATTERN)) {
    if (match[1]) {
      addBlockedPathCandidate(match[1], blockedPaths, desktopPath);
    }
  }
  for (const match of output.matchAll(POWERSHELL_FORMAT_LIST_PATH_PATTERN)) {
    if (match[1]) {
      addBlockedPathCandidate(match[1], blockedPaths, desktopPath);
    }
  }
  for (const match of output.matchAll(WINDOWS_PATH_LINE_PATTERN)) {
    if (match[0]) {
      addBlockedPathCandidate(match[0], blockedPaths, desktopPath);
    }
  }
}

/**
 * Detects whether one action result failed because a folder move hit an in-use lock.
 *
 * @param actionResult - Completed action result from the task runner.
 * @returns `true` when the output or violation text contains the canonical folder-lock signal.
 */
export function hasWorkspaceRecoveryFolderInUseSignal(
  actionResult: ActionRunResult
): boolean {
  if (
    typeof actionResult.output === "string" &&
    LOCAL_FOLDER_IN_USE_PATTERN.test(actionResult.output)
  ) {
    return true;
  }
  return actionResult.violations.some((violation) =>
    LOCAL_FOLDER_IN_USE_PATTERN.test(violation.message)
  );
}

/**
 * Extracts exact blocked folder paths from a completed task result.
 *
 * @param taskRunResult - Completed task result being evaluated for workspace recovery.
 * @returns Unique blocked folder paths in first-seen order.
 */
export function extractBlockedFolderPaths(
  taskRunResult: TaskRunResult
): readonly string[] {
  const blockedPaths = new Set<string>();
  for (const actionResult of taskRunResult.actionResults) {
    if (!hasWorkspaceRecoveryFolderInUseSignal(actionResult)) {
      continue;
    }
    if (typeof actionResult.output !== "string" || actionResult.output.trim().length === 0) {
      continue;
    }
    const payload = readJsonPayloadFromOutput(actionResult.output);
    if (payload) {
      const payloadRecord = payload as Record<string, unknown>;
      const desktopPath =
        (typeof payloadRecord.desktop === "string" && payloadRecord.desktop.trim().length > 0
          ? payloadRecord.desktop.trim()
          : null) ??
        (typeof payloadRecord.Desktop === "string" && payloadRecord.Desktop.trim().length > 0
          ? payloadRecord.Desktop.trim()
          : null) ??
        (typeof payloadRecord.destination === "string" &&
        payloadRecord.destination.trim().length > 0
          ? dirnameCrossPlatformPath(payloadRecord.destination.trim())
          : null) ??
        (typeof payloadRecord.Destination === "string" &&
        payloadRecord.Destination.trim().length > 0
          ? dirnameCrossPlatformPath(payloadRecord.Destination.trim())
          : null) ??
        resolveDesktopPathFromEnvironment();
      collectBlockedFolderPathsFromUnknown(payload, blockedPaths, desktopPath);
    }
    collectBlockedFolderPathsFromShellOutput(actionResult.output, blockedPaths);
  }
  return Array.from(blockedPaths);
}
