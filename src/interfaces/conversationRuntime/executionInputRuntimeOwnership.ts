/**
 * @fileoverview Reconciles persisted conversation ownership state with live runtime snapshots for execution input assembly.
 */

import {
  dirnameCrossPlatformPath,
  localFileUrlToAbsolutePath
} from "../../core/crossPlatformPath";
import type { BrowserSessionSnapshot } from "../../organs/liveRun/browserSessionRegistry";
import type { ManagedProcessSnapshot } from "../../organs/liveRun/managedProcessRegistry";
import type {
  ConversationActiveWorkspaceRecord,
  ConversationBrowserSessionRecord,
  ConversationSession,
  ConversationWorkspaceOwnershipState,
  ConversationWorkspacePreviewStackState
} from "../sessionStore";

/**
 * Indexes live browser-session snapshots by session id for fast record overlay.
 */
function buildBrowserSnapshotIndex(
  browserSessionSnapshots: readonly BrowserSessionSnapshot[] | undefined
): ReadonlyMap<string, BrowserSessionSnapshot> {
  return new Map(
    (browserSessionSnapshots ?? []).map((snapshot) => [snapshot.sessionId, snapshot])
  );
}

/**
 * Indexes managed-process snapshots by lease id for workspace ownership reconciliation.
 */
function buildManagedProcessSnapshotIndex(
  managedProcessSnapshots: readonly ManagedProcessSnapshot[] | undefined
): ReadonlyMap<string, ManagedProcessSnapshot> {
  return new Map(
    (managedProcessSnapshots ?? []).map((snapshot) => [snapshot.leaseId, snapshot])
  );
}

interface DerivedLocalPreviewPaths {
  rootPath: string | null;
  primaryArtifactPath: string | null;
}

/**
 * Derives a local workspace envelope from a tracked file:// preview when the runtime did not
 * persist the workspace root or artifact path explicitly.
 */
function deriveLocalPreviewPaths(previewUrl: string | null | undefined): DerivedLocalPreviewPaths {
  if (!previewUrl?.startsWith("file://")) {
    return {
      rootPath: null,
      primaryArtifactPath: null
    };
  }

  try {
    const primaryArtifactPath = localFileUrlToAbsolutePath(previewUrl);
    if (!primaryArtifactPath) {
      return {
        rootPath: null,
        primaryArtifactPath: null
      };
    }
    return {
      rootPath: dirnameCrossPlatformPath(primaryArtifactPath),
      primaryArtifactPath
    };
  } catch {
    return {
      rootPath: null,
      primaryArtifactPath: null
    };
  }
}

/**
 * Overlays one persisted browser-session record with the live runtime snapshot when available.
 */
function overlayBrowserSessionRecord(
  record: ConversationBrowserSessionRecord,
  browserSessionSnapshot: BrowserSessionSnapshot | undefined
): ConversationBrowserSessionRecord {
  if (!browserSessionSnapshot) {
    return record;
  }
  const derivedPreviewPaths = deriveLocalPreviewPaths(browserSessionSnapshot.url);
  return {
    ...record,
    url: browserSessionSnapshot.url,
    status: browserSessionSnapshot.status,
    openedAt: browserSessionSnapshot.openedAt,
    closedAt: browserSessionSnapshot.closedAt,
    visibility: browserSessionSnapshot.visibility,
    controllerKind: browserSessionSnapshot.controllerKind,
    controlAvailable: browserSessionSnapshot.controlAvailable,
    browserProcessPid: browserSessionSnapshot.browserProcessPid,
    workspaceRootPath:
      browserSessionSnapshot.workspaceRootPath ??
      derivedPreviewPaths.rootPath ??
      record.workspaceRootPath,
    linkedProcessLeaseId: browserSessionSnapshot.linkedProcessLeaseId,
    linkedProcessCwd: browserSessionSnapshot.linkedProcessCwd,
    linkedProcessPid: browserSessionSnapshot.linkedProcessPid
  };
}

/**
 * Derives the preview-stack state from the presence of browser and preview-process resources.
 */
function deriveWorkspacePreviewStackState(
  hasOpenBrowser: boolean,
  hasLivePreview: boolean
): ConversationWorkspacePreviewStackState {
  if (hasOpenBrowser && hasLivePreview) {
    return "browser_and_preview";
  }
  if (hasOpenBrowser) {
    return "browser_only";
  }
  if (hasLivePreview) {
    return "preview_only";
  }
  return "detached";
}

/**
 * Derives the strongest ownership-state classification from reconciled browser/process evidence.
 */
function deriveWorkspaceOwnershipState(
  existingOwnershipState: ConversationWorkspaceOwnershipState,
  hasCurrentTrackedBrowser: boolean,
  hasLivePreview: boolean,
  hasOpenBrowser: boolean,
  hasAnyMatchedResource: boolean
): ConversationWorkspaceOwnershipState {
  if (hasCurrentTrackedBrowser || hasLivePreview) {
    return "tracked";
  }
  if (hasOpenBrowser) {
    return "orphaned";
  }
  if (hasAnyMatchedResource) {
    return "stale";
  }
  return existingOwnershipState;
}

/**
 * Reconciles the persisted active-workspace envelope against live browser/process snapshots.
 */
function reconcileActiveWorkspaceRuntimeState(
  activeWorkspace: ConversationActiveWorkspaceRecord | null,
  browserSessions: readonly ConversationBrowserSessionRecord[],
  managedProcessSnapshotByLeaseId: ReadonlyMap<string, ManagedProcessSnapshot>
): ConversationActiveWorkspaceRecord | null {
  if (!activeWorkspace) {
    return null;
  }

  const matchingBrowserSessions = browserSessions.filter(
    (browserSession) =>
      activeWorkspace.browserSessionIds.includes(browserSession.id) ||
      browserSession.id === activeWorkspace.browserSessionId
  );
  const matchingPreviewProcesses = activeWorkspace.previewProcessLeaseIds
    .map((leaseId) => managedProcessSnapshotByLeaseId.get(leaseId))
    .filter((snapshot): snapshot is ManagedProcessSnapshot => Boolean(snapshot));
  if (
    activeWorkspace.previewProcessLeaseId &&
    !activeWorkspace.previewProcessLeaseIds.includes(activeWorkspace.previewProcessLeaseId)
  ) {
    const preferredSnapshot = managedProcessSnapshotByLeaseId.get(
      activeWorkspace.previewProcessLeaseId
    );
    if (preferredSnapshot) {
      matchingPreviewProcesses.unshift(preferredSnapshot);
    }
  }

  const openBrowserSessions = matchingBrowserSessions.filter(
    (browserSession) => browserSession.status === "open"
  );
  const controllableBrowserSession =
    openBrowserSessions.find((browserSession) => browserSession.controlAvailable) ?? null;
  const preferredBrowserSession =
    (activeWorkspace.browserSessionId
      ? matchingBrowserSessions.find(
          (browserSession) => browserSession.id === activeWorkspace.browserSessionId
        ) ?? null
      : null) ??
    openBrowserSessions[0] ??
    matchingBrowserSessions[0] ??
    null;
  const livePreviewProcess =
    matchingPreviewProcesses.find((snapshot) => snapshot.statusCode !== "PROCESS_STOPPED") ?? null;
  const derivedPreviewPaths = deriveLocalPreviewPaths(
    preferredBrowserSession?.url ?? activeWorkspace.previewUrl
  );

  const hasOpenBrowser = openBrowserSessions.length > 0;
  const hasLivePreview = livePreviewProcess !== null;
  const hasCurrentTrackedBrowser = Boolean(controllableBrowserSession);
  const hasAnyMatchedResource =
    matchingBrowserSessions.length > 0 || matchingPreviewProcesses.length > 0;

  return {
    ...activeWorkspace,
    rootPath:
      activeWorkspace.rootPath ??
      preferredBrowserSession?.workspaceRootPath ??
      livePreviewProcess?.cwd ??
      derivedPreviewPaths.rootPath,
    primaryArtifactPath:
      activeWorkspace.primaryArtifactPath ?? derivedPreviewPaths.primaryArtifactPath,
    browserSessionStatus: preferredBrowserSession?.status ?? activeWorkspace.browserSessionStatus,
    browserProcessPid:
      preferredBrowserSession?.browserProcessPid ?? activeWorkspace.browserProcessPid,
    previewProcessCwd:
      livePreviewProcess?.cwd ??
      activeWorkspace.previewProcessCwd ??
      derivedPreviewPaths.rootPath,
    lastKnownPreviewProcessPid:
      livePreviewProcess?.pid ?? activeWorkspace.lastKnownPreviewProcessPid,
    stillControllable: hasCurrentTrackedBrowser || hasLivePreview,
    ownershipState: deriveWorkspaceOwnershipState(
      activeWorkspace.ownershipState,
      hasCurrentTrackedBrowser,
      hasLivePreview,
      hasOpenBrowser,
      hasAnyMatchedResource
    ),
    previewStackState: deriveWorkspacePreviewStackState(hasOpenBrowser, hasLivePreview)
  };
}

/**
 * Overlays persisted session ownership state with live runtime browser/process snapshots for
 * execution-input rendering only.
 *
 * @param session - Persisted conversation session.
 * @param browserSessionSnapshots - Runtime-owned browser-session snapshots.
 * @param managedProcessSnapshots - Runtime-owned process snapshots.
 * @returns Session view reconciled against live runtime ownership state.
 */
export function reconcileConversationExecutionRuntimeSession(
  session: ConversationSession,
  browserSessionSnapshots: readonly BrowserSessionSnapshot[] | undefined,
  managedProcessSnapshots: readonly ManagedProcessSnapshot[] | undefined
): ConversationSession {
  if (
    (!browserSessionSnapshots || browserSessionSnapshots.length === 0) &&
    (!managedProcessSnapshots || managedProcessSnapshots.length === 0)
  ) {
    return session;
  }

  const browserSessionSnapshotById = buildBrowserSnapshotIndex(browserSessionSnapshots);
  const managedProcessSnapshotByLeaseId = buildManagedProcessSnapshotIndex(managedProcessSnapshots);
  const browserSessions = session.browserSessions.map((record) =>
    overlayBrowserSessionRecord(record, browserSessionSnapshotById.get(record.id))
  );
  const activeWorkspace = reconcileActiveWorkspaceRuntimeState(
    session.activeWorkspace,
    browserSessions,
    managedProcessSnapshotByLeaseId
  );

  return {
    ...session,
    browserSessions,
    activeWorkspace
  };
}
