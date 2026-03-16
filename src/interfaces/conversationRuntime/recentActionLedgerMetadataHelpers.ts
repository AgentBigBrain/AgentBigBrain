/**
 * @fileoverview Shared metadata parsing and label helpers used below the recent-action ledger entrypoint.
 */

import { basenameCrossPlatformPath } from "../../core/crossPlatformPath";
import type { ActionRunResult } from "../../core/types";
import type { ConversationPathDestinationRecord } from "../sessionStore";

export interface LinkedBrowserSessionCleanupRecord {
  sessionId: string;
  url: string;
  status: "open" | "closed";
  visibility: "visible" | "headless";
  controllerKind: "playwright_managed" | "os_default";
  controlAvailable: boolean;
  browserProcessPid: number | null;
  workspaceRootPath: string | null;
  linkedProcessLeaseId: string | null;
  linkedProcessCwd: string | null;
  linkedProcessPid: number | null;
}

/**
 * Normalizes unknown metadata values into non-empty strings when present.
 *
 * @param value - Metadata candidate.
 * @returns Trimmed string value, or `null` when the input is empty or non-string.
 */
export function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Normalizes unknown metadata values into integer process ids when present.
 *
 * @param value - Metadata candidate.
 * @returns Integer value, or `null` when the input is missing or not an integer.
 */
export function normalizeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Parses linked browser-session cleanup metadata emitted by exact runtime cleanup actions.
 *
 * @param value - Raw execution metadata value.
 * @returns Validated cleanup records.
 */
export function parseLinkedBrowserSessionCleanupRecords(
  value: unknown
): LinkedBrowserSessionCleanupRecord[] {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        return [];
      }
      const record = candidate as Partial<LinkedBrowserSessionCleanupRecord>;
      if (
        typeof record.sessionId !== "string" ||
        typeof record.url !== "string"
      ) {
        return [];
      }
      return [{
        sessionId: record.sessionId,
        url: record.url,
        status: record.status === "closed" ? "closed" : "open",
        visibility: record.visibility === "headless" ? "headless" : "visible",
        controllerKind:
          record.controllerKind === "os_default" ? "os_default" : "playwright_managed",
        controlAvailable: record.controlAvailable === true,
        browserProcessPid: normalizeInteger(record.browserProcessPid),
        workspaceRootPath: normalizeString(record.workspaceRootPath),
        linkedProcessLeaseId: normalizeString(record.linkedProcessLeaseId),
        linkedProcessCwd: normalizeString(record.linkedProcessCwd),
        linkedProcessPid: normalizeInteger(record.linkedProcessPid)
      }];
    });
  } catch {
    return [];
  }
}

/**
 * Builds a user-facing label for a tracked file path.
 *
 * @param targetPath - Absolute or relative file path.
 * @returns Human-readable file label.
 */
export function fileLabel(targetPath: string): string {
  const baseName = basenameCrossPlatformPath(targetPath);
  return baseName ? `File ${baseName}` : `File ${targetPath}`;
}

/**
 * Builds a user-facing label for a tracked folder path.
 *
 * @param targetPath - Absolute or relative folder path.
 * @returns Human-readable folder label.
 */
export function folderLabel(targetPath: string): string {
  const baseName = basenameCrossPlatformPath(targetPath);
  return baseName ? `Folder ${baseName}` : `Folder ${targetPath}`;
}

/**
 * Condenses raw action output into a short recent-action summary.
 *
 * @param actionResult - Completed action result from the task runner.
 * @returns Bounded human-readable summary.
 */
export function summarizeActionOutput(actionResult: ActionRunResult): string {
  const output = normalizeString(actionResult.output);
  if (!output) {
    return "Completed successfully.";
  }
  return output.length > 180 ? `${output.slice(0, 177)}...` : output;
}

/**
 * Creates one remembered destination record for later "where did you put it?" questions.
 *
 * @param id - Stable destination id.
 * @param label - Human-readable destination label.
 * @param resolvedPath - Resolved file or folder path.
 * @param sourceJobId - Session job that produced the destination.
 * @param updatedAt - Timestamp for ordering and freshness.
 * @returns Path destination record.
 */
export function buildPathDestination(
  id: string,
  label: string,
  resolvedPath: string,
  sourceJobId: string,
  updatedAt: string
): ConversationPathDestinationRecord {
  return {
    id,
    label,
    resolvedPath,
    sourceJobId,
    updatedAt
  };
}
