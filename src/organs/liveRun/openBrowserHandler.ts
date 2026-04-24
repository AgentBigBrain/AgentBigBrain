/**
 * @fileoverview Launches a visible local browser window and records a persistent browser-session handle when possible.
 */

import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  dirnameCrossPlatformPath,
  localFileUrlToAbsolutePath
} from "../../core/crossPlatformPath";
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
  captureBrowserPid?: boolean;
  useChildPid?: boolean;
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
}

const BROWSER_PID_CAPTURE_TIMEOUT_MS = 1_500;

/**
 * Checks path exists.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `access` (import `access`) from `node:fs/promises`.
 * @param candidatePath - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
async function pathExists(candidatePath: string | null | undefined): Promise<boolean> {
  if (!candidatePath || candidatePath.trim().length === 0) {
    return false;
  }
  try {
    await access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds windows direct browser executable.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `path` (import `path`) from `node:path`.
 * @returns Result produced by this helper.
 */
async function findWindowsDirectBrowserExecutable(): Promise<string | null> {
  const explicitOverride = process.env.ABB_BROWSER_EXECUTABLE?.trim() ?? "";
  if (explicitOverride.length > 0 && (await pathExists(explicitOverride))) {
    return explicitOverride;
  }

  const programFiles = process.env.ProgramFiles?.trim() ?? "";
  const programFilesX86 = process.env["ProgramFiles(x86)"]?.trim() ?? "";
  const localAppData = process.env.LOCALAPPDATA?.trim() ?? "";
  const candidates = [
    programFiles ? path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe") : null,
    programFilesX86
      ? path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe")
      : null,
    localAppData ? path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe") : null,
    programFiles
      ? path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe")
      : null,
    programFilesX86
      ? path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe")
      : null
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Normalizes comparable path.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
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
 * Evaluates whether missing preview process lease id.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function isMissingPreviewProcessLeaseId(value: string | null): boolean {
  if (!value) {
    return true;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length === 0 || normalized === "none" || normalized === "null";
}

/**
 * Derives local file workspace root path.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `dirnameCrossPlatformPath` (import `dirnameCrossPlatformPath`) from `../../core/crossPlatformPath`.
 * - Uses `localFileUrlToAbsolutePath` (import `localFileUrlToAbsolutePath`) from `../../core/crossPlatformPath`.
 * @param urlValue - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function deriveLocalFileWorkspaceRootPath(urlValue: string): string | null {
  if (!urlValue.startsWith("file://")) {
    return null;
  }
  try {
    const localPath = localFileUrlToAbsolutePath(urlValue);
    return localPath ? dirnameCrossPlatformPath(localPath) : null;
  } catch {
    return null;
  }
}

/**
 * Evaluates whether reuse browser session for ownership.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `BrowserSessionSnapshot` (import `BrowserSessionSnapshot`) from `./browserSessionRegistry`.
 * @param session - Input consumed by this helper.
 * @param workspaceRootPath - Input consumed by this helper.
 * @param linkedProcessLeaseId - Input consumed by this helper.
 * @param linkedProcessCwd - Input consumed by this helper.
 * @returns Result produced by this helper.
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
 * Infers linked preview process snapshot.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `LiveRunExecutorContext` (import `LiveRunExecutorContext`) from `./contracts`.
 * - Uses `ManagedProcessSnapshot` (import `ManagedProcessSnapshot`) from `./managedProcessRegistry`.
 * @param context - Input consumed by this helper.
 * @param workspaceRootPath - Input consumed by this helper.
 * @param taskId - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function inferLinkedPreviewProcessSnapshot(
  context: LiveRunExecutorContext,
  workspaceRootPath: string | null,
  taskId?: string
): ManagedProcessSnapshot | null {
  const allActiveSnapshots = context.managedProcessRegistry
    .listSnapshots()
    .filter(
      (snapshot) => snapshot.statusCode !== "PROCESS_STOPPED"
    )
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  if (allActiveSnapshots.length === 0) {
    return null;
  }

  const activeSnapshots = taskId
    ? allActiveSnapshots.filter((snapshot) => snapshot.taskId === taskId)
    : allActiveSnapshots;
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
async function buildBrowserOpenLaunchSpec(url: string): Promise<BrowserOpenLaunchSpec> {
  switch (process.platform) {
    case "win32": {
      const directBrowserExecutable = await findWindowsDirectBrowserExecutable();
      if (directBrowserExecutable) {
        return {
          executable: directBrowserExecutable,
          args: ["--new-window", url],
          openMethod: "direct_browser_executable",
          useChildPid: true
        };
      }
      return {
        executable: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "$ErrorActionPreference='Stop'; $p = Start-Process -FilePath $env:ABB_BROWSER_URL -PassThru; if ($null -ne $p -and $null -ne $p.Id) { [Console]::Out.WriteLine($p.Id) }"
        ],
        openMethod: "powershell_start_process",
        captureBrowserPid: true,
        env: {
          ...process.env,
          ABB_BROWSER_URL: url
        }
      };
    }
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
    const handleAbort = (): void => {
      finalize(() => reject(createAbortError()));
    };
    const handleSpawn = (): void => {
      finalize(() => resolve());
    };
    const handleError = (error: Error): void => {
      finalize(() => reject(error));
    };
    const finalize = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (signal) {
        signal.removeEventListener("abort", handleAbort);
      }
      child.removeListener("spawn", handleSpawn);
      child.removeListener("error", handleError);
      callback();
    };

    if (signal) {
      signal.addEventListener("abort", handleAbort, { once: true });
    }

    child.once("spawn", handleSpawn);
    child.once("error", handleError);
  });
}

/**
 * Reads an exact browser pid from a short-lived launcher child when the platform-specific launch
 * method can surface one deterministically.
 *
 * @param child - Spawned launcher child.
 * @param signal - Optional abort signal propagated from the runtime.
 * @returns Browser pid, or `null` when none could be recovered.
 */
async function captureLaunchedBrowserPid(
  child: ReturnType<LiveRunExecutorContext["shellSpawn"]>,
  signal?: AbortSignal
): Promise<number | null> {
  if (!child.stdout) {
    return null;
  }
  const chunks: string[] = [];
  child.stdout.setEncoding?.("utf8");
  const handleData = (chunk: unknown): void => {
    chunks.push(String(chunk));
  };
  child.stdout.on("data", handleData);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      finalize(resolve);
    }, BROWSER_PID_CAPTURE_TIMEOUT_MS);
    const handleAbort = (): void => {
      finalize(() => reject(createAbortError()));
    };
    const handleDone = (): void => {
      finalize(resolve);
    };
    const handleError = (error: Error): void => {
      finalize(() => reject(error));
    };
    const finalize = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      if (signal) {
        signal.removeEventListener("abort", handleAbort);
      }
      child.stdout?.removeListener("data", handleData);
      child.removeListener("close", handleDone);
      child.removeListener("exit", handleDone);
      child.removeListener("error", handleError);
      callback();
    };
    if (signal) {
      signal.addEventListener("abort", handleAbort, { once: true });
    }
    child.once("close", handleDone);
    child.once("exit", handleDone);
    child.once("error", handleError);
  });
  const match = chunks.join("").match(/\b(\d{2,10})\b/);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
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
  const requestedWorkspaceRootPath = normalizeOptionalString(params.rootPath);
  const derivedLocalFileWorkspaceRootPath = isLocalFileUrl
    ? deriveLocalFileWorkspaceRootPath(normalizedUrl)
    : null;
  const workspaceRootPath = derivedLocalFileWorkspaceRootPath ?? requestedWorkspaceRootPath;
  const rawExplicitLinkedPreviewProcessLeaseId = normalizeOptionalString(params.previewProcessLeaseId);
  const explicitLinkedPreviewProcessLeaseId = isMissingPreviewProcessLeaseId(
    rawExplicitLinkedPreviewProcessLeaseId
  )
    ? null
    : rawExplicitLinkedPreviewProcessLeaseId;
  const inferredLinkedPreviewProcessSnapshot =
    rawExplicitLinkedPreviewProcessLeaseId === null
      ? inferLinkedPreviewProcessSnapshot(context, workspaceRootPath, taskId)
      : null;
  const linkedPreviewProcessLeaseId =
    explicitLinkedPreviewProcessLeaseId ?? inferredLinkedPreviewProcessSnapshot?.leaseId ?? null;
  const linkedPreviewProcessSnapshot = linkedPreviewProcessLeaseId
    ? context.managedProcessRegistry.getSnapshot(linkedPreviewProcessLeaseId)
    : inferredLinkedPreviewProcessSnapshot;
  const linkedProcessLeaseId = linkedPreviewProcessSnapshot?.leaseId ?? linkedPreviewProcessLeaseId;
  const linkedProcessCwd = linkedProcessLeaseId
    ? (linkedPreviewProcessSnapshot?.cwd ?? workspaceRootPath)
    : null;
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

    const launchSpec = await buildBrowserOpenLaunchSpec(normalizedUrl);
    const child = context.shellSpawn(
      launchSpec.executable,
      launchSpec.args,
      {
        detached: true,
        stdio: launchSpec.captureBrowserPid ? ["ignore", "pipe", "ignore"] : "ignore",
        env: launchSpec.env,
        windowsHide: true,
        windowsVerbatimArguments: launchSpec.windowsVerbatimArguments ?? false
      }
    );
    const browserPidCapturePromise = launchSpec.captureBrowserPid
      ? captureLaunchedBrowserPid(child, signal)
      : Promise.resolve<number | null>(null);
    await waitForBrowserOpenLaunch(child, signal);
    const capturedBrowserPid = await browserPidCapturePromise;
    const browserProcessPid =
      capturedBrowserPid ??
      (launchSpec.useChildPid && typeof child.pid === "number" && Number.isInteger(child.pid)
        ? child.pid
        : null);
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
      linkedProcessPid,
      browserProcessPid
    });
    return buildExecutionOutcome(
      "success",
      snapshot.controlAvailable
        ? `Opened ${normalizedUrl} in your visible browser and left it open for you.`
        : `Opened ${normalizedUrl} in your visible browser and left it open. This window may need to be closed manually later because runtime control is unavailable here.`,
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
