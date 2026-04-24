/**
 * @fileoverview Tracks persistent browser sessions that can stay open and later be reused or closed.
 */

import { createAbortError, isAbortError, throwIfAborted } from "../../core/runtimeAbort";
import type {
  BrowserVerifierBrowser,
  BrowserVerifierContext,
  BrowserVerifierPage
} from "./playwrightRuntime";
import { isProcessLikelyAlive } from "./processLiveness";
import {
  readBrowserSessionPersistedState,
  writeBrowserSessionPersistedState
} from "./browserSessionRegistryPersistence";

export type BrowserSessionControllerKind = "playwright_managed" | "os_default";
export type BrowserSessionVisibility = "visible" | "headless";
export type BrowserSessionStatus = "open" | "closed";

export interface BrowserSessionSnapshot {
  sessionId: string;
  url: string;
  status: BrowserSessionStatus;
  openedAt: string;
  closedAt: string | null;
  visibility: BrowserSessionVisibility;
  controllerKind: BrowserSessionControllerKind;
  controlAvailable: boolean;
  browserProcessPid: number | null;
  workspaceRootPath: string | null;
  linkedProcessLeaseId: string | null;
  linkedProcessCwd: string | null;
  linkedProcessPid: number | null;
}

/**
 * Returns whether one browser-session snapshot is still a current exact tracked runtime resource.
 *
 * @param snapshot - Browser-session snapshot to classify.
 * @returns `true` when the session is open and still controllable by the runtime.
 */
export function isCurrentTrackedBrowserSessionSnapshot(
  snapshot: BrowserSessionSnapshot
): boolean {
  return snapshot.status === "open" && snapshot.controlAvailable;
}

/**
 * Returns whether one browser-session snapshot represents stale earlier assistant work.
 *
 * @param snapshot - Browser-session snapshot to classify.
 * @returns `true` when the session is already closed.
 */
export function isStaleTrackedBrowserSessionSnapshot(
  snapshot: BrowserSessionSnapshot
): boolean {
  return snapshot.status === "closed";
}

/**
 * Returns whether one browser-session snapshot is still attributable to earlier assistant work but
 * no longer directly controllable by the runtime.
 *
 * @param snapshot - Browser-session snapshot to classify.
 * @returns `true` when the session is open but not controllable.
 */
export function isOrphanedAttributableBrowserSessionSnapshot(
  snapshot: BrowserSessionSnapshot
): boolean {
  return snapshot.status === "open" && !snapshot.controlAvailable;
}

interface ManagedBrowserSessionHandle {
  browser: BrowserVerifierBrowser;
  context: BrowserVerifierContext;
  page: BrowserVerifierPage;
}

interface BrowserSessionRecord extends BrowserSessionSnapshot {
  handle: ManagedBrowserSessionHandle | null;
  browserProcessPid: number | null;
}

export interface BrowserSessionRegistryOptions {
  snapshotPath?: string | null;
  isProcessAlive?: (pid: number | null) => boolean;
}

const STALE_UNCONTROLLED_MANAGED_SESSION_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Waits for one browser automation promise while respecting an optional abort signal.
 *
 * @param operation - Browser automation step in flight.
 * @param signal - Optional abort signal propagated from the executor.
 * @returns Promise resolving to the original operation result.
 */
async function awaitWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) {
    return operation;
  }
  return await Promise.race([
    operation,
    new Promise<T>((_resolve, reject) => {
      const handleAbort = (): void => {
        signal.removeEventListener("abort", handleAbort);
        reject(createAbortError());
      };
      signal.addEventListener("abort", handleAbort, { once: true });
    })
  ]);
}

/**
 * Closes one browser automation resource when it exposes a `close()` method.
 *
 * @param resource - Browser automation resource that may expose `close()`.
 * @returns Promise resolving when teardown work finishes.
 */
async function closeIfPossible(resource: { close?: () => Promise<void> } | null): Promise<void> {
  if (!resource || typeof resource.close !== "function") {
    return;
  }
  try {
    await resource.close();
  } catch {
    // The desired end-state is closed; teardown errors should not keep stale sessions open.
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
 * Returns an immutable snapshot for one tracked session record.
 *
 * @param record - Internal browser-session record.
 * @returns Public snapshot safe for callers and metadata builders.
 */
function snapshotFromRecord(record: BrowserSessionRecord): BrowserSessionSnapshot {
  return {
    sessionId: record.sessionId,
    url: record.url,
    status: record.status,
    openedAt: record.openedAt,
    closedAt: record.closedAt,
    visibility: record.visibility,
    controllerKind: record.controllerKind,
    controlAvailable: record.controlAvailable,
    browserProcessPid: record.browserProcessPid,
    workspaceRootPath: record.workspaceRootPath,
    linkedProcessLeaseId: record.linkedProcessLeaseId,
    linkedProcessCwd: record.linkedProcessCwd,
    linkedProcessPid: record.linkedProcessPid
  };
}

/**
 * Returns whether a persisted browser-session record is old enough that the runtime should stop
 * treating an uncontrollable managed window as still open.
 *
 * @param openedAt - ISO timestamp recorded when the browser session first opened.
 * @returns `true` when the record is older than the bounded stale-session threshold.
 */
function isOlderThanStaleManagedSessionThreshold(openedAt: string): boolean {
  const openedAtMs = Date.parse(openedAt);
  if (!Number.isFinite(openedAtMs)) {
    return true;
  }
  return Date.now() - openedAtMs >= STALE_UNCONTROLLED_MANAGED_SESSION_MAX_AGE_MS;
}

/**
 * Tracks persistent browser sessions for reuse, recall, and later closure.
 */
export class BrowserSessionRegistry {
  private readonly sessions = new Map<string, BrowserSessionRecord>();
  private readonly snapshotPath: string | null;
  private readonly isProcessAlive: (pid: number | null) => boolean;

  /**
   * Initializes `BrowserSessionRegistry` with optional snapshot persistence.
   *
   * @param options - Optional persistence configuration.
   */
  constructor(options: BrowserSessionRegistryOptions = {}) {
    this.snapshotPath = options.snapshotPath ?? null;
    this.isProcessAlive = options.isProcessAlive ?? isProcessLikelyAlive;
    this.hydratePersistedSessions();
  }

  /**
   * Returns the current snapshot for one tracked session id.
   *
   * @param sessionId - Browser session identifier.
   * @returns Current snapshot, or `null` when the session is unknown.
   */
  getSnapshot(sessionId: string): BrowserSessionSnapshot | null {
    const record = this.sessions.get(sessionId);
    if (record && this.reconcileBrowserSessionRecord(record)) {
      this.persistSessions();
    }
    return record ? snapshotFromRecord(record) : null;
  }

  /**
   * Lists all tracked browser-session snapshots in caller-owned form.
   *
   * @returns Snapshot copies for every tracked browser session.
   */
  listSnapshots(): BrowserSessionSnapshot[] {
    this.reconcilePersistedSessions();
    return [...this.sessions.values()].map((record) => snapshotFromRecord(record));
  }

  /**
   * Returns the newest open session for one URL when it is still tracked.
   *
   * @param url - Absolute URL to match.
   * @returns Matching open session snapshot, or `null` when none is tracked.
   */
  findOpenSessionByUrl(url: string): BrowserSessionSnapshot | null {
    this.reconcilePersistedSessions();
    const normalizedUrl = normalizeSessionUrl(url);
    const match = [...this.sessions.values()]
      .filter((record) => record.status === "open" && record.url === normalizedUrl)
      .sort((left, right) => right.openedAt.localeCompare(left.openedAt))[0];
    return match ? snapshotFromRecord(match) : null;
  }

  /**
   * Returns the newest open session for one URL when live page/context handles are still available.
   *
   * @param url - Absolute URL to match.
   * @returns Matching reusable open session snapshot, or `null` when none can be reused.
   */
  findReusableOpenSessionByUrl(url: string): BrowserSessionSnapshot | null {
    this.reconcilePersistedSessions();
    const normalizedUrl = normalizeSessionUrl(url);
    const match = [...this.sessions.values()]
      .filter(
        (record) =>
          record.status === "open" &&
          record.url === normalizedUrl &&
          record.handle !== null
      )
      .sort((left, right) => right.openedAt.localeCompare(left.openedAt))[0];
    return match ? snapshotFromRecord(match) : null;
  }

  /**
   * Registers a Playwright-managed browser session that can be controlled later.
   *
   * @param details - Session metadata plus Playwright handles.
   * @returns Snapshot of the registered session.
   */
  registerManagedSession(details: {
    sessionId: string;
    url: string;
    visibility: BrowserSessionVisibility;
    openedAt: string;
    browser: BrowserVerifierBrowser;
    context: BrowserVerifierContext;
    page: BrowserVerifierPage;
    browserProcessPid?: number | null;
    workspaceRootPath?: string | null;
    linkedProcessLeaseId?: string | null;
    linkedProcessCwd?: string | null;
    linkedProcessPid?: number | null;
  }): BrowserSessionSnapshot {
    const record: BrowserSessionRecord = {
      sessionId: details.sessionId,
      url: normalizeSessionUrl(details.url),
      status: "open",
      openedAt: details.openedAt,
      closedAt: null,
      visibility: details.visibility,
      controllerKind: "playwright_managed",
      controlAvailable: true,
      handle: {
        browser: details.browser,
        context: details.context,
        page: details.page
      },
      browserProcessPid:
        typeof details.browserProcessPid === "number" && Number.isInteger(details.browserProcessPid)
          ? details.browserProcessPid
          : null,
      workspaceRootPath:
        typeof details.workspaceRootPath === "string" ? details.workspaceRootPath : null,
      linkedProcessLeaseId:
        typeof details.linkedProcessLeaseId === "string" ? details.linkedProcessLeaseId : null,
      linkedProcessCwd:
        typeof details.linkedProcessCwd === "string" ? details.linkedProcessCwd : null,
      linkedProcessPid:
        typeof details.linkedProcessPid === "number" && Number.isInteger(details.linkedProcessPid)
          ? details.linkedProcessPid
          : null
    };
    this.sessions.set(record.sessionId, record);
    this.persistSessions();
    return snapshotFromRecord(record);
  }

  /**
   * Registers a detached browser session opened through the OS default browser.
   *
   * @param details - Session metadata for a non-controllable browser window.
   * @returns Snapshot of the registered session.
   */
  registerDetachedSession(details: {
    sessionId: string;
    url: string;
    visibility: BrowserSessionVisibility;
    openedAt: string;
    browserProcessPid?: number | null;
    workspaceRootPath?: string | null;
    linkedProcessLeaseId?: string | null;
    linkedProcessCwd?: string | null;
    linkedProcessPid?: number | null;
  }): BrowserSessionSnapshot {
    const record: BrowserSessionRecord = {
      sessionId: details.sessionId,
      url: normalizeSessionUrl(details.url),
      status: "open",
      openedAt: details.openedAt,
      closedAt: null,
      visibility: details.visibility,
      controllerKind: "os_default",
      // OS-default launches remain attribution-only even when a launcher surfaces a PID.
      // A shared desktop browser can reuse existing processes, so exact window control is not
      // reliable enough to advertise as runtime-owned.
      controlAvailable: false,
      handle: null,
      browserProcessPid:
        typeof details.browserProcessPid === "number" &&
        Number.isInteger(details.browserProcessPid)
          ? details.browserProcessPid
          : null,
      workspaceRootPath:
        typeof details.workspaceRootPath === "string" ? details.workspaceRootPath : null,
      linkedProcessLeaseId:
        typeof details.linkedProcessLeaseId === "string" ? details.linkedProcessLeaseId : null,
      linkedProcessCwd:
        typeof details.linkedProcessCwd === "string" ? details.linkedProcessCwd : null,
      linkedProcessPid:
        typeof details.linkedProcessPid === "number" && Number.isInteger(details.linkedProcessPid)
          ? details.linkedProcessPid
          : null
    };
    this.sessions.set(record.sessionId, record);
    this.persistSessions();
    return snapshotFromRecord(record);
  }

  /**
   * Backfills workspace ownership metadata for a tracked browser session when newer exact context
   * becomes available after the session was first opened.
   *
   * @param sessionId - Existing tracked session id.
   * @param details - Optional ownership metadata to persist.
   * @returns Updated snapshot, or `null` when the session is unknown.
   */
  annotateSessionOwnership(
    sessionId: string,
    details: {
      workspaceRootPath?: string | null;
      linkedProcessLeaseId?: string | null;
      linkedProcessCwd?: string | null;
      linkedProcessPid?: number | null;
    }
  ): BrowserSessionSnapshot | null {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return null;
    }
    record.workspaceRootPath =
      typeof details.workspaceRootPath === "string"
        ? details.workspaceRootPath
        : record.workspaceRootPath;
    record.linkedProcessLeaseId =
      typeof details.linkedProcessLeaseId === "string"
        ? details.linkedProcessLeaseId
        : record.linkedProcessLeaseId;
    record.linkedProcessCwd =
      typeof details.linkedProcessCwd === "string"
        ? details.linkedProcessCwd
        : record.linkedProcessCwd;
    record.linkedProcessPid =
      typeof details.linkedProcessPid === "number" && Number.isInteger(details.linkedProcessPid)
        ? details.linkedProcessPid
        : record.linkedProcessPid;
    this.persistSessions();
    return snapshotFromRecord(record);
  }

  /**
   * Reuses a currently open controllable session by refreshing it and bringing it forward.
   *
   * @param sessionId - Existing tracked session id.
   * @param timeoutMs - Timeout budget for the refresh/navigation step.
   * @param signal - Optional abort signal propagated from the executor.
   * @returns Refreshed session snapshot, or `null` when the session can no longer be reused.
   */
  async reuseOpenSession(
    sessionId: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<BrowserSessionSnapshot | null> {
    const record = this.sessions.get(sessionId);
    if (!record || record.status !== "open" || !record.controlAvailable || !record.handle) {
      return record ? snapshotFromRecord(record) : null;
    }

    try {
      if (typeof record.handle.page.bringToFront === "function") {
        await awaitWithAbort(record.handle.page.bringToFront(), signal);
      }
      if (typeof record.handle.page.reload === "function") {
        await awaitWithAbort(
          record.handle.page.reload({
            waitUntil: "domcontentloaded",
            timeout: timeoutMs
          }),
          signal
        );
      } else {
        await awaitWithAbort(
          record.handle.page.goto(record.url, {
            waitUntil: "domcontentloaded",
            timeout: timeoutMs
          }),
          signal
        );
      }
      return snapshotFromRecord(record);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      record.status = "closed";
      record.closedAt = new Date().toISOString();
      record.handle = null;
      this.persistSessions();
      return null;
    }
  }

  /**
   * Marks one tracked session as closed and releases any retained automation handles.
   *
   * @param sessionId - Existing tracked session id.
   * @param signal - Optional abort signal propagated from the executor.
   * @returns Final closed-session snapshot, or `null` when the session is unknown.
   */
  async closeSession(
    sessionId: string,
    signal?: AbortSignal,
    closeProcessByPid?: (pid: number) => Promise<boolean>
  ): Promise<BrowserSessionSnapshot | null> {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return null;
    }
    if (record.status === "closed") {
      return snapshotFromRecord(record);
    }

    throwIfAborted(signal);
    if (record.handle) {
      await closeIfPossible(record.handle.page);
      await closeIfPossible(record.handle.context);
      await closeIfPossible(record.handle.browser);
      record.handle = null;
    } else if (
      record.controllerKind === "playwright_managed" &&
      typeof record.browserProcessPid === "number" &&
      closeProcessByPid
    ) {
      const closedByPid = await closeProcessByPid(record.browserProcessPid);
      if (!closedByPid) {
        return snapshotFromRecord(record);
      }
    }
    record.status = "closed";
    record.closedAt = new Date().toISOString();
    record.controlAvailable = false;
    this.persistSessions();
    return snapshotFromRecord(record);
  }

  /**
   * Downgrades one exact linked browser session to a closed stale record after the runtime shut
   * down the preview resource it was attributable to but no longer has direct browser control.
   *
   * @param sessionId - Existing tracked session id.
   * @returns Closed-session snapshot, or `null` when the session is unknown.
   */
  markSessionClosedFromLinkedResourceShutdown(
    sessionId: string
  ): BrowserSessionSnapshot | null {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return null;
    }
    if (record.status === "closed") {
      return snapshotFromRecord(record);
    }
    record.status = "closed";
    record.closedAt ??= new Date().toISOString();
    record.controlAvailable = false;
    record.handle = null;
    record.browserProcessPid = null;
    this.persistSessions();
    return snapshotFromRecord(record);
  }

  /**
   * Loads persisted browser sessions so follow-up turns can recover prior visible-page context.
   */
  private hydratePersistedSessions(): void {
    const persistedState = readBrowserSessionPersistedState(this.snapshotPath);
    for (const session of persistedState.sessions) {
      const record: BrowserSessionRecord = {
        ...session,
        controlAvailable:
          session.status === "open" &&
          session.controllerKind === "playwright_managed" &&
          typeof session.browserProcessPid === "number",
        handle: null
      };
      this.sessions.set(record.sessionId, record);
    }
    this.reconcilePersistedSessions();
  }

  /**
   * Reconciles persisted browser-session records against current local liveness.
   */
  private reconcilePersistedSessions(): void {
    let changed = false;
    for (const record of this.sessions.values()) {
      changed = this.reconcileBrowserSessionRecord(record) || changed;
    }
    if (changed) {
      this.persistSessions();
    }
  }

  /**
   * Reconciles one persisted browser-session record against current local PID liveness.
   *
   * @param record - Internal browser-session record.
   * @returns `true` when reconciliation changed persisted state.
   */
  private reconcileBrowserSessionRecord(record: BrowserSessionRecord): boolean {
    if (record.status === "closed" || record.handle !== null) {
      return false;
    }
    const browserProcessStillAlive = this.isProcessAlive(record.browserProcessPid);
    const linkedPreviewStillAlive = this.isProcessAlive(record.linkedProcessPid);
    const shouldCloseRecord =
      (typeof record.browserProcessPid === "number" && !browserProcessStillAlive) ||
      (
        typeof record.browserProcessPid !== "number" &&
        typeof record.linkedProcessPid === "number" &&
        !linkedPreviewStillAlive &&
        !record.controlAvailable
      ) ||
      (
        record.controllerKind === "playwright_managed" &&
        !record.controlAvailable &&
        typeof record.browserProcessPid !== "number" &&
        typeof record.linkedProcessPid !== "number" &&
        record.linkedProcessLeaseId === null &&
        isOlderThanStaleManagedSessionThreshold(record.openedAt)
      );
    if (!shouldCloseRecord) {
      record.controlAvailable =
        record.status === "open" &&
        record.controllerKind === "playwright_managed" &&
        typeof record.browserProcessPid === "number" &&
        browserProcessStillAlive;
      return false;
    }
    record.status = "closed";
    record.closedAt ??= new Date().toISOString();
    record.controlAvailable = false;
    return true;
  }

  /**
   * Persists browser sessions for later runtime recovery.
   */
  private persistSessions(): void {
    writeBrowserSessionPersistedState(
      this.snapshotPath,
      [...this.sessions.values()].map((record) => ({
        ...snapshotFromRecord(record),
        controlAvailable:
          record.status === "open" &&
          record.controllerKind === "playwright_managed" &&
          typeof record.browserProcessPid === "number" &&
          Number.isInteger(record.browserProcessPid),
        browserProcessPid: record.browserProcessPid
      }))
    );
  }
}
