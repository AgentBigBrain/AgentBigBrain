/**
 * @fileoverview Persistence helpers for durable browser-session recovery.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type {
  BrowserSessionControllerKind,
  BrowserSessionSnapshot,
  BrowserSessionStatus,
  BrowserSessionVisibility
} from "./browserSessionRegistry";

export interface PersistedBrowserSessionRecord extends BrowserSessionSnapshot {
  browserProcessPid: number | null;
}

export interface BrowserSessionRegistryPersistedState {
  version: 1;
  sessions: PersistedBrowserSessionRecord[];
}

/**
 * Writes the current persisted browser-session payload to disk.
 *
 * @param snapshotPath - Optional registry snapshot path.
 * @param sessions - Persisted session rows to save.
 */
export function writeBrowserSessionPersistedState(
  snapshotPath: string | null,
  sessions: readonly PersistedBrowserSessionRecord[]
): void {
  if (!snapshotPath) {
    return;
  }
  const payload: BrowserSessionRegistryPersistedState = {
    version: 1,
    sessions: [...sessions]
  };
  mkdirSync(path.dirname(snapshotPath), { recursive: true });
  writeFileSync(snapshotPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/**
 * Reads persisted browser-session snapshots from disk.
 *
 * @param snapshotPath - Optional registry snapshot path.
 * @returns Parsed persisted state, or an empty default on missing/unreadable files.
 */
export function readBrowserSessionPersistedState(
  snapshotPath: string | null
): BrowserSessionRegistryPersistedState {
  if (!snapshotPath || !existsSync(snapshotPath)) {
    return {
      version: 1,
      sessions: []
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(snapshotPath, "utf8")) as Partial<BrowserSessionRegistryPersistedState>;
    return {
      version: 1,
      sessions: Array.isArray(parsed.sessions)
        ? parsed.sessions
            .map((candidate) => normalizePersistedBrowserSession(candidate))
            .filter((candidate): candidate is PersistedBrowserSessionRecord => candidate !== null)
        : []
    };
  } catch (error) {
    console.warn(
      `[BrowserSessionRegistry] Failed to read persisted sessions from "${snapshotPath}": ${(error as Error).message}`
    );
    return {
      version: 1,
      sessions: []
    };
  }
}

/**
 * Normalizes one absolute URL into a stable string form used for browser-session matching.
 *
 * @param url - Absolute URL to normalize.
 * @returns Canonical URL string.
 */
function normalizeSessionUrl(url: string): string {
  return new URL(url).toString();
}

/**
 * Normalizes one unknown persisted browser-session payload into the current contract.
 *
 * @param value - Persisted browser-session candidate.
 * @returns Valid persisted session, or `null` when the payload is not usable.
 */
function normalizePersistedBrowserSession(value: unknown): PersistedBrowserSessionRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Partial<PersistedBrowserSessionRecord>;
  if (
    typeof candidate.sessionId !== "string" ||
    typeof candidate.url !== "string" ||
    typeof candidate.status !== "string" ||
    typeof candidate.openedAt !== "string" ||
    typeof candidate.visibility !== "string" ||
    typeof candidate.controllerKind !== "string"
  ) {
    return null;
  }
  const status = normalizeBrowserSessionStatus(candidate.status);
  const visibility = normalizeBrowserSessionVisibility(candidate.visibility);
  const controllerKind = normalizeBrowserSessionControllerKind(candidate.controllerKind);
  return {
    sessionId: candidate.sessionId,
    url: normalizeSessionUrl(candidate.url),
    status,
    openedAt: candidate.openedAt,
    closedAt: typeof candidate.closedAt === "string" ? candidate.closedAt : null,
    visibility,
    controllerKind,
    controlAvailable:
      status === "open" &&
      controllerKind === "playwright_managed" &&
      typeof candidate.browserProcessPid === "number",
    browserProcessPid:
      typeof candidate.browserProcessPid === "number" && Number.isInteger(candidate.browserProcessPid)
        ? candidate.browserProcessPid
        : null,
    workspaceRootPath:
      typeof candidate.workspaceRootPath === "string" ? candidate.workspaceRootPath : null,
    linkedProcessLeaseId:
      typeof candidate.linkedProcessLeaseId === "string" ? candidate.linkedProcessLeaseId : null,
    linkedProcessCwd:
      typeof candidate.linkedProcessCwd === "string" ? candidate.linkedProcessCwd : null,
    linkedProcessPid:
      typeof candidate.linkedProcessPid === "number" && Number.isInteger(candidate.linkedProcessPid)
        ? candidate.linkedProcessPid
        : null
  };
}

/**
 * Normalizes a persisted browser-session status into the current contract.
 *
 * @param status - Unknown persisted status.
 * @returns Supported browser-session status.
 */
function normalizeBrowserSessionStatus(status: string): BrowserSessionStatus {
  return status === "closed" ? "closed" : "open";
}

/**
 * Normalizes a persisted browser-session visibility into the current contract.
 *
 * @param visibility - Unknown persisted visibility.
 * @returns Supported browser-session visibility.
 */
function normalizeBrowserSessionVisibility(visibility: string): BrowserSessionVisibility {
  return visibility === "headless" ? "headless" : "visible";
}

/**
 * Normalizes a persisted browser-session controller kind into the current contract.
 *
 * @param controllerKind - Unknown persisted controller kind.
 * @returns Supported browser-session controller kind.
 */
function normalizeBrowserSessionControllerKind(
  controllerKind: string
): BrowserSessionControllerKind {
  return controllerKind === "os_default" ? "os_default" : "playwright_managed";
}
