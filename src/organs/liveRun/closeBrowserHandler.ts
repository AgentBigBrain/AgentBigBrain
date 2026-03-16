/**
 * @fileoverview Closes tracked persistent browser sessions that the runtime previously opened.
 */

import { CloseBrowserActionParams, ExecutorExecutionOutcome } from "../../core/types";
import { isAllowedBrowserSessionControlUrl } from "../../core/constraintRuntime/browserConstraints";
import { throwIfAborted } from "../../core/runtimeAbort";
import {
  buildBrowserSessionExecutionMetadata,
  buildExecutionOutcome,
  isLoopbackBrowserVerificationHost,
  LiveRunExecutorContext,
  normalizeOptionalString
} from "./contracts";
import type { BrowserSessionSnapshot } from "./browserSessionRegistry";

/**
 * Resolves one tracked browser session id from the action params and current registry state.
 *
 * @param context - Shared executor dependencies for live-run capability handlers.
 * @param params - Structured planner params for this browser-close request.
 * @returns Session snapshot plus resolved session id, or `null` when no tracked match exists.
 */
function resolveTrackedBrowserSession(
  context: LiveRunExecutorContext,
  params: CloseBrowserActionParams
): {
  sessionId: string;
} | null {
  const sessionId = normalizeOptionalString(params.sessionId);
  if (sessionId) {
    return context.browserSessionRegistry.getSnapshot(sessionId) ? { sessionId } : null;
  }

  const urlValue = normalizeOptionalString(params.url);
  if (!urlValue) {
    return null;
  }

  try {
    const parsedUrl = new URL(urlValue);
    if (
      parsedUrl.protocol !== "http:" &&
      parsedUrl.protocol !== "https:" &&
      parsedUrl.protocol !== "file:"
    ) {
      return null;
    }
    if (
      (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") &&
      !isLoopbackBrowserVerificationHost(parsedUrl.hostname)
    ) {
      return null;
    }
    if (!isAllowedBrowserSessionControlUrl(parsedUrl)) {
      return null;
    }
    const snapshot = context.browserSessionRegistry.findOpenSessionByUrl(parsedUrl.toString());
    return snapshot ? { sessionId: snapshot.sessionId } : null;
  } catch {
    return null;
  }
}

/**
 * Returns whether the tracked browser session's linked preview resource is already stopped.
 *
 * @param context - Shared executor dependencies for live-run capability handlers.
 * @param snapshot - Browser-session snapshot currently being evaluated.
 * @returns `true` when the linked preview resource is no longer running.
 */
function isLinkedPreviewAlreadyStopped(
  context: LiveRunExecutorContext,
  snapshot: BrowserSessionSnapshot
): boolean {
  if (typeof snapshot.linkedProcessLeaseId === "string") {
    const linkedProcessSnapshot = context.managedProcessRegistry.getSnapshot(
      snapshot.linkedProcessLeaseId
    );
    if (linkedProcessSnapshot?.statusCode === "PROCESS_STOPPED") {
      return true;
    }
  }
  return (
    typeof snapshot.linkedProcessPid === "number" &&
    !context.isProcessRunning(snapshot.linkedProcessPid)
  );
}

/**
 * Returns whether one tracked managed browser session can still be reclaimed by exact runtime-
 * owned browser pid even after direct Playwright handle control was lost.
 *
 * @param snapshot - Browser-session snapshot currently being evaluated.
 * @returns `true` when an exact runtime-owned browser pid is still available.
 */
function canCloseManagedBrowserByExactPid(snapshot: BrowserSessionSnapshot): boolean {
  return (
    snapshot.controllerKind === "playwright_managed" &&
    typeof snapshot.browserProcessPid === "number" &&
    Number.isInteger(snapshot.browserProcessPid)
  );
}

/**
 * Executes `close_browser` for a tracked browser session.
 *
 * @param context - Shared executor dependencies for live-run capability handlers.
 * @param params - Structured planner params for this browser-close request.
 * @param signal - Optional abort signal propagated from the runtime.
 * @returns Promise resolving to a typed executor outcome.
 */
export async function executeCloseBrowser(
  context: LiveRunExecutorContext,
  params: CloseBrowserActionParams,
  signal?: AbortSignal
): Promise<ExecutorExecutionOutcome> {
  throwIfAborted(signal);
  const sessionResolution = resolveTrackedBrowserSession(context, params);
  if (!sessionResolution) {
    return buildExecutionOutcome(
      "blocked",
      "Browser close blocked: no tracked browser session matched params.sessionId or params.url.",
      "BROWSER_SESSION_NOT_FOUND"
    );
  }

  const snapshot = context.browserSessionRegistry.getSnapshot(sessionResolution.sessionId);
  if (!snapshot) {
    return buildExecutionOutcome(
      "blocked",
      "Browser close blocked: the tracked browser session is no longer available.",
      "BROWSER_SESSION_NOT_FOUND"
    );
  }

  if (!snapshot.controlAvailable && !canCloseManagedBrowserByExactPid(snapshot)) {
    if (
      snapshot.controllerKind === "playwright_managed" &&
      isLinkedPreviewAlreadyStopped(context, snapshot)
    ) {
      const closedSnapshot =
        context.browserSessionRegistry.markSessionClosedFromLinkedResourceShutdown(
          sessionResolution.sessionId
        );
      if (!closedSnapshot) {
        return buildExecutionOutcome(
          "blocked",
          "Browser close blocked: the tracked browser session disappeared before it could be reconciled.",
          "BROWSER_SESSION_NOT_FOUND"
        );
      }
      return buildExecutionOutcome(
        "success",
        `The linked preview process was already stopped, so I marked the tracked browser session for ${closedSnapshot.url} closed.`,
        undefined,
        buildBrowserSessionExecutionMetadata({
          sessionId: closedSnapshot.sessionId,
          url: closedSnapshot.url,
          status: closedSnapshot.status,
          visibility: closedSnapshot.visibility,
          controllerKind: closedSnapshot.controllerKind,
          controlAvailable: closedSnapshot.controlAvailable,
          browserProcessPid: closedSnapshot.browserProcessPid,
          workspaceRootPath: closedSnapshot.workspaceRootPath,
          linkedProcessLeaseId: closedSnapshot.linkedProcessLeaseId,
          linkedProcessCwd: closedSnapshot.linkedProcessCwd,
          linkedProcessPid: closedSnapshot.linkedProcessPid,
          openMethod: closedSnapshot.controllerKind
        })
      );
    }
    return buildExecutionOutcome(
      "blocked",
      `Browser close blocked: ${snapshot.url} was opened without runtime control and may need to be closed manually.`,
      "BROWSER_SESSION_CONTROL_UNAVAILABLE",
      buildBrowserSessionExecutionMetadata({
        sessionId: snapshot.sessionId,
        url: snapshot.url,
        status: snapshot.status,
        visibility: snapshot.visibility,
        controllerKind: snapshot.controllerKind,
        controlAvailable: snapshot.controlAvailable,
        browserProcessPid: snapshot.browserProcessPid,
        workspaceRootPath: snapshot.workspaceRootPath,
        linkedProcessLeaseId: snapshot.linkedProcessLeaseId,
        linkedProcessCwd: snapshot.linkedProcessCwd,
        linkedProcessPid: snapshot.linkedProcessPid,
        openMethod: snapshot.controllerKind
      })
    );
  }

  const wasAlreadyClosed = snapshot.status === "closed";
  const closedSnapshot = await context.browserSessionRegistry.closeSession(
    sessionResolution.sessionId,
    signal,
    context.terminateProcessTreeByPid
  );
  if (!closedSnapshot) {
    return buildExecutionOutcome(
      "blocked",
      "Browser close blocked: the tracked browser session disappeared before it could be closed.",
      "BROWSER_SESSION_NOT_FOUND"
    );
  }
  if (closedSnapshot.status !== "closed") {
    return buildExecutionOutcome(
      "failed",
      `Browser close failed: runtime could not close the tracked browser session for ${closedSnapshot.url}.`,
      "ACTION_EXECUTION_FAILED",
      buildBrowserSessionExecutionMetadata({
        sessionId: closedSnapshot.sessionId,
        url: closedSnapshot.url,
        status: closedSnapshot.status,
        visibility: closedSnapshot.visibility,
        controllerKind: closedSnapshot.controllerKind,
        controlAvailable: closedSnapshot.controlAvailable,
        browserProcessPid: closedSnapshot.browserProcessPid,
        workspaceRootPath: closedSnapshot.workspaceRootPath,
        linkedProcessLeaseId: closedSnapshot.linkedProcessLeaseId,
        linkedProcessCwd: closedSnapshot.linkedProcessCwd,
        linkedProcessPid: closedSnapshot.linkedProcessPid,
        openMethod: closedSnapshot.controllerKind
      })
    );
  }

  return buildExecutionOutcome(
    "success",
    wasAlreadyClosed
      ? `The browser window for ${closedSnapshot.url} was already closed.`
      : `Closed the browser window for ${closedSnapshot.url}.`,
    undefined,
    buildBrowserSessionExecutionMetadata({
      sessionId: closedSnapshot.sessionId,
      url: closedSnapshot.url,
      status: closedSnapshot.status,
      visibility: closedSnapshot.visibility,
      controllerKind: closedSnapshot.controllerKind,
      controlAvailable: closedSnapshot.controlAvailable,
      browserProcessPid: closedSnapshot.browserProcessPid,
      workspaceRootPath: closedSnapshot.workspaceRootPath,
      linkedProcessLeaseId: closedSnapshot.linkedProcessLeaseId,
      linkedProcessCwd: closedSnapshot.linkedProcessCwd,
      linkedProcessPid: closedSnapshot.linkedProcessPid,
      openMethod: closedSnapshot.controllerKind
    })
  );
}
