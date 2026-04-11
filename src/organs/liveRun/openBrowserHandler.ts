/**
 * @fileoverview Launches a visible local browser window and records a persistent browser-session handle when possible.
 */

import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { OpenBrowserActionParams, ExecutorExecutionOutcome } from "../../core/types";
import { isAllowedBrowserSessionControlUrl } from "../../core/constraintRuntime/browserConstraints";
import { createAbortError, isAbortError, throwIfAborted } from "../../core/runtimeAbort";
import {
  buildBrowserSessionExecutionMetadata,
  buildExecutionOutcome,
  isLoopbackBrowserVerificationHost,
  LiveRunExecutorContext,
  normalizeOptionalString,
  resolveReadinessProbeTimeoutMs,
  waitForLocalHttpReadiness
} from "./contracts";
import {
  BrowserVerifierBrowser,
  BrowserVerifierContext,
  BrowserVerifierPage,
  loadPlaywrightChromium
} from "./playwrightRuntime";
import {
  findNewPlaywrightAutomationBrowserPid,
  listPlaywrightAutomationBrowserProcesses
} from "./playwrightBrowserProcessIntrospection";
import type { BrowserSessionSnapshot } from "./browserSessionRegistry";
import type { ManagedProcessSnapshot } from "./managedProcessRegistry";

interface BrowserOpenLaunchSpec {
  executable: string;
  args: readonly string[];
  openMethod: string;
  windowsVerbatimArguments?: boolean;
}

/**
 * Normalizes one local path into a stable comparable value.
 *
 * @param value - Candidate local path.
 * @returns Comparable path, or `null` when the input is blank.
 */
function normalizeComparablePath(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Returns whether one tracked browser session still belongs to the same runtime ownership envelope
 * requested by the current browser-open action.
 *
 * @param session - Existing reusable browser session candidate.
 * @param workspaceRootPath - Requested workspace root for the current open action.
 * @param linkedProcessLeaseId - Requested linked preview-process lease id.
 * @param linkedProcessCwd - Requested linked preview-process cwd.
 * @returns `true` when the existing session is ownership-compatible with the current request.
 */
function canReuseBrowserSessionForOwnership(
  session: BrowserSessionSnapshot,
  workspaceRootPath: string | null,
  linkedProcessLeaseId: string | null,
  linkedProcessCwd: string | null
): boolean {
  if (
    linkedProcessLeaseId &&
    session.linkedProcessLeaseId &&
    session.linkedProcessLeaseId !== linkedProcessLeaseId
  ) {
    return false;
  }

  const requestedComparableRoots = new Set(
    [workspaceRootPath, linkedProcessCwd]
      .map((value) => normalizeComparablePath(value))
      .filter((value): value is string => value !== null)
  );
  if (requestedComparableRoots.size === 0) {
    return true;
  }

  const existingComparableRoots = new Set(
    [session.workspaceRootPath, session.linkedProcessCwd]
      .map((value) => normalizeComparablePath(value))
      .filter((value): value is string => value !== null)
  );
  if (existingComparableRoots.size === 0) {
    return true;
  }

  for (const comparableRoot of requestedComparableRoots) {
    if (existingComparableRoots.has(comparableRoot)) {
      return true;
    }
  }
  return false;
}

/**
 * Chooses the most relevant managed preview-process snapshot to link to a browser-open action when
 * the planner omitted `previewProcessLeaseId` but the runtime can still prove the active preview
 * from current task/workspace context.
 *
 * @param context - Shared executor dependencies for live-run capability handlers.
 * @param workspaceRootPath - Current workspace root when known.
 * @param taskId - Owning task id for the browser-open action.
 * @returns Inferred managed-process snapshot, or `null` when the runtime cannot prove one.
 */
function inferLinkedPreviewProcessSnapshot(
  context: LiveRunExecutorContext,
  workspaceRootPath: string | null,
  taskId?: string
): ManagedProcessSnapshot | null {
  if (!taskId) {
    return null;
  }

  const activeSnapshots = context.managedProcessRegistry
    .listSnapshots()
    .filter(
      (snapshot) => snapshot.taskId === taskId && snapshot.statusCode !== "PROCESS_STOPPED"
    )
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  if (activeSnapshots.length === 0) {
    return null;
  }

  const comparableWorkspaceRoot = normalizeComparablePath(workspaceRootPath);
  if (comparableWorkspaceRoot) {
    const matchingWorkspaceSnapshots = activeSnapshots.filter(
      (snapshot) => normalizeComparablePath(snapshot.cwd) === comparableWorkspaceRoot
    );
    if (matchingWorkspaceSnapshots.length === 1) {
      return matchingWorkspaceSnapshots[0] ?? null;
    }
    if (
      matchingWorkspaceSnapshots.length > 1 &&
      matchingWorkspaceSnapshots.every(
        (snapshot) => normalizeComparablePath(snapshot.cwd) === comparableWorkspaceRoot
      )
    ) {
      return matchingWorkspaceSnapshots[0] ?? null;
    }
  }

  if (activeSnapshots.length === 1) {
    return activeSnapshots[0] ?? null;
  }

  const uniqueComparableCwds = new Set(
    activeSnapshots
      .map((snapshot) => normalizeComparablePath(snapshot.cwd))
      .filter((snapshotCwd): snapshotCwd is string => snapshotCwd !== null)
  );
  if (uniqueComparableCwds.size === 1) {
    return activeSnapshots[0] ?? null;
  }

  return null;
}

/**
 * Builds the OS-specific browser-launch command used when managed Playwright control is unavailable.
 *
 * @param url - Local preview URL to open in the user's browser.
 * @returns Platform-specific launch specification.
 */
function buildBrowserOpenLaunchSpec(url: string): BrowserOpenLaunchSpec {
  switch (process.platform) {
    case "win32":
      return {
        executable: "cmd.exe",
        args: ["/d", "/c", "start", "", url],
        openMethod: "cmd_start",
        windowsVerbatimArguments: true
      };
    case "darwin":
      return {
        executable: "open",
        args: [url],
        openMethod: "open"
      };
    default:
      return {
        executable: "xdg-open",
        args: [url],
        openMethod: "xdg_open"
      };
  }
}

/**
 * Waits for a spawned browser-launch child to either start successfully or fail immediately.
 *
 * @param child - Spawned child handle for the OS browser launcher.
 * @param signal - Optional abort signal propagated from the runtime.
 * @returns Promise resolving when the launcher successfully spawns.
 */
async function waitForBrowserOpenLaunch(
  child: ReturnType<LiveRunExecutorContext["shellSpawn"]>,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finalize = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (signal) {
        signal.removeEventListener("abort", handleAbort);
      }
      child.removeAllListeners("spawn");
      child.removeAllListeners("error");
      callback();
    };

    const handleAbort = (): void => {
      finalize(() => reject(createAbortError()));
    };

    if (signal) {
      signal.addEventListener("abort", handleAbort, { once: true });
    }

    child.once("spawn", () => {
      finalize(() => resolve());
    });
    child.once("error", (error) => {
      finalize(() => reject(error));
    });
  });
}

/**
 * Executes `open_browser` by launching a visible local browser session that can stay open.
 *
 * @param context - Shared executor dependencies for live-run capability handlers.
 * @param actionId - Stable action id used to derive the browser-session record id.
 * @param params - Structured planner params for this browser-open request.
 * @param signal - Optional abort signal propagated from the runtime.
 * @returns Promise resolving to a typed executor outcome.
 */
export async function executeOpenBrowser(
  context: LiveRunExecutorContext,
  actionId: string,
  params: OpenBrowserActionParams,
  signal?: AbortSignal,
  taskId?: string
): Promise<ExecutorExecutionOutcome> {
  throwIfAborted(signal);
  const url = normalizeOptionalString(params.url);
  if (!url) {
    return buildExecutionOutcome(
      "blocked",
      "Browser open blocked: missing params.url.",
      "BROWSER_VERIFY_MISSING_URL"
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return buildExecutionOutcome(
      "blocked",
      "Browser open blocked: params.url must be a valid absolute URL.",
      "BROWSER_VERIFY_URL_INVALID"
    );
  }

  const isLoopbackHttpUrl =
    (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") &&
    isLoopbackBrowserVerificationHost(parsedUrl.hostname);
  const isLocalFileUrl = parsedUrl.protocol === "file:" && isAllowedBrowserSessionControlUrl(parsedUrl);
  if (
    parsedUrl.protocol !== "http:" &&
    parsedUrl.protocol !== "https:" &&
    parsedUrl.protocol !== "file:"
  ) {
    return buildExecutionOutcome(
      "blocked",
      "Browser open blocked: params.url must use http, https, or file.",
      "BROWSER_VERIFY_URL_INVALID"
    );
  }
  if (!isLoopbackHttpUrl && !isLocalFileUrl) {
    return buildExecutionOutcome(
      "blocked",
      parsedUrl.protocol === "file:"
        ? "Browser open blocked: params.url file target must be a local absolute path."
        : "Browser open blocked: params.url must target localhost, 127.0.0.1, ::1, or a local file URL.",
      parsedUrl.protocol === "file:" ? "BROWSER_VERIFY_URL_INVALID" : "BROWSER_VERIFY_URL_NOT_LOCAL"
    );
  }

  const normalizedUrl = parsedUrl.toString();
  const sessionId = `browser_session:${actionId}`;
  const workspaceRootPath = normalizeOptionalString(params.rootPath);
  const explicitLinkedPreviewProcessLeaseId = normalizeOptionalString(params.previewProcessLeaseId);
  const inferredLinkedPreviewProcessSnapshot =
    explicitLinkedPreviewProcessLeaseId === null
      ? inferLinkedPreviewProcessSnapshot(context, workspaceRootPath, taskId)
      : null;
  const linkedPreviewProcessLeaseId =
    explicitLinkedPreviewProcessLeaseId ?? inferredLinkedPreviewProcessSnapshot?.leaseId ?? null;
  const linkedPreviewProcessSnapshot = linkedPreviewProcessLeaseId
    ? context.managedProcessRegistry.getSnapshot(linkedPreviewProcessLeaseId)
    : inferredLinkedPreviewProcessSnapshot;
  const linkedProcessLeaseId = linkedPreviewProcessSnapshot?.leaseId ?? linkedPreviewProcessLeaseId;
  const linkedProcessCwd = linkedPreviewProcessSnapshot?.cwd ?? workspaceRootPath;
  const linkedProcessPid = linkedPreviewProcessSnapshot?.pid ?? null;
  const lifecycleCode = isLoopbackHttpUrl ? "PROCESS_READY" : null;
  const timeoutMs = resolveReadinessProbeTimeoutMs(
    context.config,
    typeof params.timeoutMs === "number" ? params.timeoutMs : undefined
  );

  try {
    if (isLoopbackHttpUrl) {
      const readiness = await waitForLocalHttpReadiness(parsedUrl, timeoutMs, null, signal);
      if (!readiness.ready) {
        const failureDetail =
          readiness.observedStatus === null
            ? `no HTTP response within ${timeoutMs}ms`
            : `status ${readiness.observedStatus}`;
        return buildExecutionOutcome(
          "failed",
          `Browser open failed: ${normalizedUrl} never became ready (${failureDetail}).`,
          "PROCESS_NOT_READY"
        );
      }
    }

    if (isLocalFileUrl) {
      const localFilePath = fileURLToPath(parsedUrl);
      try {
        await access(localFilePath);
      } catch {
        return buildExecutionOutcome(
          "failed",
          `Browser open failed: local file does not exist at ${localFilePath}.`,
          "ACTION_EXECUTION_FAILED"
        );
      }
    }

    const existingSession = context.browserSessionRegistry.findReusableOpenSessionByUrl(normalizedUrl);
    if (
      existingSession &&
      canReuseBrowserSessionForOwnership(
        existingSession,
        workspaceRootPath,
        linkedProcessLeaseId,
        linkedProcessCwd
      )
    ) {
      context.browserSessionRegistry.annotateSessionOwnership(existingSession.sessionId, {
        workspaceRootPath,
        linkedProcessLeaseId,
        linkedProcessCwd,
        linkedProcessPid
      });
      const reusedSession = await context.browserSessionRegistry.reuseOpenSession(
        existingSession.sessionId,
        timeoutMs,
        signal
      );
      if (reusedSession) {
        return buildExecutionOutcome(
          "success",
          `The existing browser window for ${normalizedUrl} is already open and was brought forward.`,
          undefined,
          buildBrowserSessionExecutionMetadata({
            sessionId: reusedSession.sessionId,
            url: reusedSession.url,
            status: reusedSession.status,
            visibility: reusedSession.visibility,
            controllerKind: reusedSession.controllerKind,
            controlAvailable: reusedSession.controlAvailable,
            browserProcessPid: reusedSession.browserProcessPid,
            workspaceRootPath: reusedSession.workspaceRootPath,
            linkedProcessLeaseId: reusedSession.linkedProcessLeaseId,
            linkedProcessCwd: reusedSession.linkedProcessCwd,
            linkedProcessPid: reusedSession.linkedProcessPid,
            openMethod: reusedSession.controllerKind,
            processLifecycleStatus: lifecycleCode
          })
        );
      }
    }

    const playwrightRuntime = await (
      context.playwrightChromiumLoader ?? loadPlaywrightChromium
    )();
    if (playwrightRuntime) {
      let browser: BrowserVerifierBrowser | null = null;
      let browserContext: BrowserVerifierContext | null = null;
      let page: BrowserVerifierPage | null = null;
      try {
        const playwrightBrowserProcessesBeforeLaunch =
          await listPlaywrightAutomationBrowserProcesses().catch(() => []);
        browser = await playwrightRuntime.chromium.launch({ headless: false });
        browserContext = await browser.newContext();
        page = await browserContext.newPage();
        await page.goto(normalizedUrl, {
          waitUntil: "domcontentloaded",
          timeout: timeoutMs
        });
        if (typeof page.bringToFront === "function") {
          await page.bringToFront();
        }
        const browserProcess = typeof browser.process === "function" ? browser.process() : null;
        const playwrightBrowserProcessesAfterLaunch =
          await listPlaywrightAutomationBrowserProcesses().catch(() => []);
        const openedAt = new Date().toISOString();
        const snapshot = context.browserSessionRegistry.registerManagedSession({
          sessionId,
          url: normalizedUrl,
          visibility: "visible",
          openedAt,
          browser,
          context: browserContext,
          page,
          browserProcessPid:
            typeof browserProcess?.pid === "number"
              ? browserProcess.pid
              : findNewPlaywrightAutomationBrowserPid(
                  playwrightBrowserProcessesBeforeLaunch,
                  playwrightBrowserProcessesAfterLaunch
                ),
          workspaceRootPath,
          linkedProcessLeaseId,
          linkedProcessCwd,
          linkedProcessPid
        });
        return buildExecutionOutcome(
          "success",
          `Opened ${normalizedUrl} in a visible browser window and left it open for you.`,
          undefined,
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
            openMethod: playwrightRuntime.sourceModule,
            processLifecycleStatus: lifecycleCode
          })
        );
      } catch (error) {
        if (page && typeof page.close === "function") {
          await page.close().catch(() => undefined);
        }
        if (browserContext) {
          await browserContext.close().catch(() => undefined);
        }
        if (browser) {
          await browser.close().catch(() => undefined);
        }
        throw error;
      }
    }

    const launchSpec = buildBrowserOpenLaunchSpec(normalizedUrl);
    const child = context.shellSpawn(
      launchSpec.executable,
      launchSpec.args,
      {
        detached: true,
        stdio: "ignore",
        windowsVerbatimArguments: launchSpec.windowsVerbatimArguments ?? false
      }
    );
    await waitForBrowserOpenLaunch(child, signal);
    if (typeof child.unref === "function") {
      child.unref();
    }
    const openedAt = new Date().toISOString();
    const snapshot = context.browserSessionRegistry.registerDetachedSession({
      sessionId,
      url: normalizedUrl,
      visibility: "visible",
      openedAt,
      workspaceRootPath,
      linkedProcessLeaseId,
      linkedProcessCwd,
      linkedProcessPid
    });
    return buildExecutionOutcome(
      "success",
      `Opened ${normalizedUrl} in your visible browser and left it open. This window may need to be closed manually later because runtime control is unavailable here.`,
      undefined,
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
        openMethod: launchSpec.openMethod,
        processLifecycleStatus: lifecycleCode
      })
    );
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return buildExecutionOutcome(
      "failed",
      `Browser open failed: ${(error as Error).message}`,
      "ACTION_EXECUTION_FAILED"
    );
  }
}
