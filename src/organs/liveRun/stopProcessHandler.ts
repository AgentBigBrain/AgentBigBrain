/**
 * @fileoverview Executes managed-process shutdown for live-run flows.
 */

import { ExecutorExecutionOutcome, StopProcessActionParams } from "../../core/types";
import {
  buildLinkedBrowserSessionCleanupMetadata,
  buildExecutionOutcome,
  buildManagedProcessExecutionMetadata,
  LiveRunExecutorContext,
  MANAGED_PROCESS_STOP_TIMEOUT_MS,
  normalizeOptionalString
} from "./contracts";
import type { BrowserSessionSnapshot } from "./browserSessionRegistry";

interface LinkedBrowserSessionCleanupResult {
  snapshot: BrowserSessionSnapshot;
  cleanupMode: "closed" | "stale_marked" | "still_open";
}

/**
 * Closes any tracked browser sessions explicitly linked to one managed preview-process lease.
 *
 * @param context - Shared executor dependencies for live-run capability handlers.
 * @param leaseId - Managed-process lease being stopped.
 * @param signal - Optional abort signal propagated from the runtime.
 * @returns Post-cleanup snapshots for each linked open session that was inspected.
 */
async function closeLinkedBrowserSessionsForLease(
  context: LiveRunExecutorContext,
  leaseId: string
) : Promise<LinkedBrowserSessionCleanupResult[]> {
  const linkedOpenSessions = context.browserSessionRegistry
    .listSnapshots()
    .filter(
      (snapshot) =>
        snapshot.status === "open" &&
        snapshot.linkedProcessLeaseId === leaseId
    );
  const cleanedSessions: LinkedBrowserSessionCleanupResult[] = [];
  for (const openSnapshot of linkedOpenSessions) {
    const shouldMarkStaleAfterLinkedShutdown =
      openSnapshot.controllerKind === "playwright_managed" &&
      !openSnapshot.controlAvailable &&
      openSnapshot.browserProcessPid === null;
    let cleanedSnapshot = shouldMarkStaleAfterLinkedShutdown
      ? context.browserSessionRegistry.markSessionClosedFromLinkedResourceShutdown(
          openSnapshot.sessionId
        )
      : await context.browserSessionRegistry.closeSession(
          openSnapshot.sessionId,
          undefined,
          context.terminateProcessTreeByPid
        );
    let cleanupMode: LinkedBrowserSessionCleanupResult["cleanupMode"] =
      shouldMarkStaleAfterLinkedShutdown && cleanedSnapshot?.status === "closed"
        ? "stale_marked"
        : cleanedSnapshot?.status === "closed"
          ? "closed"
          : "still_open";
    if (
      cleanedSnapshot &&
      cleanedSnapshot.status !== "closed" &&
      openSnapshot.controllerKind === "playwright_managed" &&
      !openSnapshot.controlAvailable
    ) {
      const downgradedSnapshot =
        context.browserSessionRegistry.markSessionClosedFromLinkedResourceShutdown(
          openSnapshot.sessionId
        );
      if (downgradedSnapshot) {
        cleanedSnapshot = downgradedSnapshot;
        cleanupMode = "stale_marked";
      }
    }
    if (cleanedSnapshot) {
      cleanedSessions.push({
        snapshot: cleanedSnapshot,
        cleanupMode
      });
    }
  }
  return cleanedSessions;
}

/**
 * Executes `stop_process` and waits for deterministic close confirmation.
 *
 * **Why it exists:**
 * Keeps managed-process stop semantics out of the generic executor so cleanup behavior stays
 * truthful and locally testable.
 *
 * **What it talks to:**
 * - Uses `ManagedProcessRegistry` and `terminateProcessTree` through `LiveRunExecutorContext`.
 *
 * @param context - Shared executor dependencies for live-run capability handlers.
 * @param params - Structured planner params for this stop request.
 * @returns Promise resolving to a typed executor outcome.
 */
export async function executeStopProcess(
  context: LiveRunExecutorContext,
  params: StopProcessActionParams
): Promise<ExecutorExecutionOutcome> {
  const leaseId = normalizeOptionalString(params.leaseId);
  const recoveredPid =
    typeof params.pid === "number" && Number.isInteger(params.pid) && params.pid > 0
      ? params.pid
      : null;
  if (!leaseId && recoveredPid === null) {
    return buildExecutionOutcome(
      "blocked",
      "Process stop blocked: missing leaseId or pid.",
      "PROCESS_MISSING_LEASE_ID"
    );
  }

  const snapshot = leaseId
    ? context.managedProcessRegistry.markStopRequested(leaseId)
    : null;
  if (leaseId && !snapshot) {
    return buildExecutionOutcome(
      "blocked",
      `Process stop blocked: unknown lease ${leaseId}.`,
      "PROCESS_LEASE_NOT_FOUND"
    );
  }
  if (snapshot?.statusCode === "PROCESS_STOPPED" && recoveredPid === null) {
    return buildExecutionOutcome(
      "success",
      `Process already stopped: lease ${snapshot.leaseId}.`,
      undefined,
      buildManagedProcessExecutionMetadata(snapshot, "PROCESS_STOPPED")
    );
  }

  const child = leaseId ? context.managedProcessRegistry.getChild(leaseId) : null;

  try {
    const killAccepted = child
      ? await context.terminateProcessTree(child)
      : recoveredPid !== null
        ? await context.terminateProcessTreeByPid(recoveredPid)
        : typeof snapshot?.pid === "number"
          ? await context.terminateProcessTreeByPid(snapshot.pid)
          : false;
    if (!killAccepted) {
      return buildExecutionOutcome(
        "failed",
        child
          ? `Process stop failed: kill signal was not accepted for lease ${leaseId}.`
          : recoveredPid !== null
            ? `Process stop failed: kill signal was not accepted for recovered pid ${recoveredPid}.`
            : `Process stop failed: no live child handle or recoverable PID was available for lease ${leaseId}.`,
        "PROCESS_STOP_FAILED"
      );
    }
    if (!child && snapshot && leaseId) {
      context.managedProcessRegistry.markRecoveredStopped(leaseId, null, "SIGTERM");
    }
    const closedSnapshot = leaseId
      ? await context.managedProcessRegistry.waitForClosed(
          leaseId,
          MANAGED_PROCESS_STOP_TIMEOUT_MS
        )
      : null;
    if (leaseId && !closedSnapshot) {
      return buildExecutionOutcome(
        "failed",
        `Process stop failed: lease ${leaseId} did not exit within ${MANAGED_PROCESS_STOP_TIMEOUT_MS}ms.`,
        "PROCESS_STOP_FAILED"
      );
    }
    const cleanedBrowserSessionResults =
      leaseId !== null
        ? await closeLinkedBrowserSessionsForLease(context, leaseId)
        : [];
    const cleanedBrowserSessions = cleanedBrowserSessionResults.map(
      (result) => result.snapshot
    );
    const closedBrowserSessionCount = cleanedBrowserSessionResults.filter(
      (result) => result.cleanupMode === "closed"
    ).length;
    const staleMarkedBrowserSessionCount = cleanedBrowserSessionResults.filter(
      (result) => result.cleanupMode === "stale_marked"
    ).length;
    const remainingOpenBrowserSessionCount =
      cleanedBrowserSessionResults.filter((result) => result.snapshot.status === "open").length;
    return buildExecutionOutcome(
      "success",
      [
        closedSnapshot
          ? `Process stopped: lease ${closedSnapshot.leaseId}.`
          : `Process stopped: pid ${recoveredPid}.`,
        closedBrowserSessionCount > 0
          ? `Closed ${closedBrowserSessionCount} linked browser window${closedBrowserSessionCount === 1 ? "" : "s"}.`
          : null,
        staleMarkedBrowserSessionCount > 0
          ? `Marked ${staleMarkedBrowserSessionCount} linked browser session${staleMarkedBrowserSessionCount === 1 ? "" : "s"} stale after shutting down the preview process.`
          : null,
        remainingOpenBrowserSessionCount > 0
          ? `${remainingOpenBrowserSessionCount} linked browser window${remainingOpenBrowserSessionCount === 1 ? "" : "s"} still need manual cleanup.`
          : null
      ]
        .filter((segment): segment is string => Boolean(segment))
        .join(" "),
      undefined,
      closedSnapshot
        ? {
            ...buildManagedProcessExecutionMetadata(closedSnapshot, "PROCESS_STOPPED"),
            ...buildLinkedBrowserSessionCleanupMetadata(cleanedBrowserSessions)
          }
        : {
            processLifecycleStatus: "PROCESS_STOPPED",
            processLeaseId: null,
            processPid: recoveredPid,
            processTaskId: null,
            processCommandFingerprint: null,
            processCwd: null,
            processShellExecutable: null,
            processShellKind: null,
            processStartedAt: null,
            processExitCode: null,
            processSignal: "SIGTERM",
            processStopRequested: true,
            ...buildLinkedBrowserSessionCleanupMetadata(cleanedBrowserSessions)
          }
    );
  } catch (error) {
    return buildExecutionOutcome(
      "failed",
      `Process stop failed: ${(error as Error).message}`,
      "PROCESS_STOP_FAILED"
    );
  }
}
