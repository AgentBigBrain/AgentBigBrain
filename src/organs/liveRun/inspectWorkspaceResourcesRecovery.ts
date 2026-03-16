/**
 * @fileoverview Shared recovery helpers for runtime-owned workspace inspection.
 */

import type { LiveRunExecutorContext } from "./contracts";
import {
  isOrphanedAttributableBrowserSessionSnapshot,
  type BrowserSessionSnapshot
} from "./browserSessionRegistry";
import type { ManagedProcessSnapshot } from "./managedProcessRegistry";

export interface RecoveredExactPreviewHolderCandidate {
  pid: number;
  leaseId: string | null;
  processName: string | null;
  reason: string;
}

/**
 * Normalizes related action or session ids into one comparable lineage key.
 *
 * @param value - Runtime resource id or action id.
 * @returns Comparable lineage key, or `null` when absent.
 */
export function normalizeRuntimeResourceLineage(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const withoutPrefix = value.startsWith("browser_session:")
    ? value.slice("browser_session:".length)
    : value;
  const withoutSuffix = withoutPrefix.replace(/:(?:open_browser|start_process)$/i, "");
  if (/^action_[^_]+_[^_]+$/i.test(withoutSuffix)) {
    return withoutSuffix;
  }
  if (/^action_[^_]+_[^_]+_.+$/i.test(withoutSuffix)) {
    return withoutSuffix.replace(/_[^_]+$/, "");
  }
  return withoutSuffix;
}

/**
 * Returns whether the provided URL points at a loopback-local preview endpoint.
 *
 * @param url - Candidate preview URL.
 * @returns `true` when the URL host is loopback-local.
 */
export function isLoopbackPreviewUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    const normalizedHost = parsedUrl.hostname.trim().toLowerCase();
    return (
      normalizedHost === "127.0.0.1" ||
      normalizedHost === "localhost" ||
      normalizedHost === "::1"
    );
  } catch {
    return false;
  }
}

/**
 * Recovers exact preview-holder pids from stale runtime lineage when newer system inspection proves
 * the same workspace preview is still being served.
 *
 * @param context - Shared live-run executor context.
 * @param trackedBrowserSessions - Current tracked browser-session matches.
 * @param trackedProcessSnapshots - Current tracked preview-process matches.
 * @param staleProcessSnapshots - Stale preview-process matches that still help recover lineage.
 * @param selectors - Current workspace/path selectors.
 * @returns Exact holder candidates that are safe enough for tracked recovery.
 */
export async function collectRecoveredExactPreviewHolders(
  context: LiveRunExecutorContext,
  trackedBrowserSessions: readonly BrowserSessionSnapshot[],
  trackedProcessSnapshots: readonly ManagedProcessSnapshot[],
  staleProcessSnapshots: readonly ManagedProcessSnapshot[],
  selectors: {
    path: string | null;
    rootPath: string | null;
    previewUrl: string | null;
  }
): Promise<readonly RecoveredExactPreviewHolderCandidate[]> {
  const allBrowserSnapshots = context.browserSessionRegistry.listSnapshots();
  const browserSessionsByLineage = new Map<string, BrowserSessionSnapshot[]>();
  for (const snapshot of allBrowserSnapshots) {
    if (!isOrphanedAttributableBrowserSessionSnapshot(snapshot) || !isLoopbackPreviewUrl(snapshot.url)) {
      continue;
    }
    const lineageKey = normalizeRuntimeResourceLineage(snapshot.sessionId);
    if (!lineageKey) {
      continue;
    }
    const existingSnapshots = browserSessionsByLineage.get(lineageKey) ?? [];
    existingSnapshots.push(snapshot);
    browserSessionsByLineage.set(lineageKey, existingSnapshots);
  }

  const exactRecoveredHolders: RecoveredExactPreviewHolderCandidate[] = [];
  const seenPids = new Set<number>();
  const trackedPids = [
    ...trackedBrowserSessions
      .map((snapshot) => snapshot.browserProcessPid)
      .filter((pid): pid is number => typeof pid === "number"),
    ...trackedProcessSnapshots
      .map((snapshot) => snapshot.pid)
      .filter((pid): pid is number => typeof pid === "number")
  ];

  for (const snapshot of staleProcessSnapshots) {
    const lineageKey = normalizeRuntimeResourceLineage(snapshot.actionId);
    if (!lineageKey) {
      continue;
    }
    const attributableBrowserSessions = browserSessionsByLineage.get(lineageKey) ?? [];
    for (const browserSnapshot of attributableBrowserSessions) {
      const candidates = context.inspectSystemPreviewCandidates
        ? await context.inspectSystemPreviewCandidates({
            targetPath: selectors.path,
            rootPath: selectors.rootPath ?? snapshot.cwd,
            previewUrl: browserSnapshot.url,
            trackedPids
          })
        : [];
      for (const candidate of candidates) {
        if (seenPids.has(candidate.pid)) {
          continue;
        }
        seenPids.add(candidate.pid);
        exactRecoveredHolders.push({
          pid: candidate.pid,
          leaseId: snapshot.leaseId,
          processName: candidate.processName,
          reason: "recovered_preview_port_from_stale_runtime_record"
        });
      }
    }
  }

  if (context.inspectSystemPreviewCandidates) {
    const contentMatchedCandidates = await context.inspectSystemPreviewCandidates({
      targetPath: selectors.path,
      rootPath: selectors.rootPath,
      previewUrl: selectors.previewUrl,
      trackedPids
    });
    for (const candidate of contentMatchedCandidates) {
      if (candidate.reason !== "served_index_matches_target_workspace") {
        continue;
      }
      if (seenPids.has(candidate.pid)) {
        continue;
      }
      seenPids.add(candidate.pid);
      exactRecoveredHolders.push({
        pid: candidate.pid,
        leaseId: null,
        processName: candidate.processName,
        reason: "served_index_matches_target_workspace"
      });
    }
  }

  return exactRecoveredHolders;
}
