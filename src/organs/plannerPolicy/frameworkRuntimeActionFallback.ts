/**
 * @fileoverview Deterministic framework-app runtime fallback actions for planner timeout recovery.
 */

import path from "node:path";
import { estimateActionCostUsd } from "../../core/actionCostPolicy";
import { extractActiveRequestSegment } from "../../core/currentRequestExtraction";
import { makeId } from "../../core/ids";
import { PlannedAction } from "../../core/types";
import { PlannerExecutionEnvironmentContext } from "./executionStyleContracts";
import { extractRequestedFrameworkFolderName } from "./frameworkBuildActionHeuristics";
import {
  buildFrameworkScaffoldCommand,
  extractTrackedPreviewProcessLeaseId,
  extractTrackedPreviewUrl,
  extractTrackedWorkspaceRoot,
  FrameworkFallbackKind,
  hasFrameworkBuildArtifacts,
  isFrameworkBrowserOpenFollowUp,
  isFrameworkPreviewFollowUp,
  resolveFrameworkFallbackKind,
  resolveFrameworkLoopbackTarget,
  resolveTrackedPreviewLoopbackTarget
} from "./frameworkRuntimeActionFallbackSupport";
import {
  buildDeterministicFrameworkTrackedEditFallbackActions,
  extractTrackedBrowserSessionId
} from "./frameworkRuntimeActionFallbackEditSupport";
import { buildFrameworkLandingPageWriteActions } from "./frameworkRuntimeActionFallbackWriteSupport";
import {
  isDeterministicFrameworkBuildLaneRequest,
  isLiveVerificationBuildRequest,
  requiresBrowserVerificationBuildRequest,
  requiresFrameworkAppScaffoldAction,
  isFrameworkWorkspacePreparationRequest,
  requiresPersistentBrowserOpenBuildRequest,
  suppressesLiveRunWork
} from "./liveVerificationPolicy";

const TRACKED_WORKSPACE_REFERENCE_PATTERN = /\b(?:reuse|existing|current|same|tracked)\b/i;

/**
 * Builds deterministic bounded framework-app fallback actions when model planning still fails
 * after repair for fresh scaffold/setup turns.
 *
 * @param currentUserRequest - Active framework-app scaffold request.
 * @param executionEnvironment - Planner execution environment context.
 * @returns Deterministic fallback actions, or an empty list when the request cannot be synthesized safely.
 */
export function buildDeterministicFrameworkBuildFallbackActions(
  requestContext: string,
  executionEnvironment: PlannerExecutionEnvironmentContext | null
): PlannedAction[] {
  if (
    executionEnvironment?.platform !== "win32" ||
    executionEnvironment.shellKind !== "powershell" ||
    !executionEnvironment.desktopPath
  ) {
    return [];
  }

  const trackedWorkspaceRoot = extractTrackedWorkspaceRoot(requestContext);
  const trackedPreviewUrl = extractTrackedPreviewUrl(requestContext);
  const trackedPreviewProcessLeaseId =
    extractTrackedPreviewProcessLeaseId(requestContext);
  const trackedBrowserSessionId =
    extractTrackedBrowserSessionId(requestContext);
  const activeRequest = extractActiveRequestSegment(requestContext).trim();
  if (!isDeterministicFrameworkBuildLaneRequest(activeRequest)) {
    return [];
  }
  const kind = resolveFrameworkFallbackKind(requestContext, trackedWorkspaceRoot);
  const trackedWorkspaceFolderName = trackedWorkspaceRoot
    ? path.win32.basename(trackedWorkspaceRoot)
    : null;
  const prefersTrackedWorkspaceFolderName =
    trackedWorkspaceFolderName !== null &&
    TRACKED_WORKSPACE_REFERENCE_PATTERN.test(activeRequest);
  const requestedFolderName =
    (prefersTrackedWorkspaceFolderName ? trackedWorkspaceFolderName : null) ??
    extractRequestedFrameworkFolderName(activeRequest) ??
    trackedWorkspaceFolderName;
  if (!kind || !requestedFolderName) {
    return [];
  }

  const finalFolderPath =
    `${executionEnvironment.desktopPath.replace(/[\\\/]+$/, "")}\\${requestedFolderName}`;
  const trackedPreviewLoopbackTarget = resolveTrackedPreviewLoopbackTarget(trackedPreviewUrl);
  const loopbackTarget =
    trackedPreviewLoopbackTarget ?? resolveFrameworkLoopbackTarget(kind, activeRequest);
  const liveUrl = loopbackTarget.url;
  const scaffoldCommand = buildFrameworkScaffoldCommand(
    kind,
    finalFolderPath,
    requestedFolderName
  );
  const liveVerificationRequested = isLiveVerificationBuildRequest(requestContext);
  const browserVerificationRequested =
    requiresBrowserVerificationBuildRequest(requestContext);
  const persistentBrowserOpenRequested =
    requiresPersistentBrowserOpenBuildRequest(requestContext);
  const workspacePreparationOnly =
    isFrameworkWorkspacePreparationRequest(requestContext);
  const previewFollowUpRequested =
    isFrameworkPreviewFollowUp(activeRequest) &&
    !suppressesLiveRunWork(activeRequest);
  const browserOpenFollowUpRequested = isFrameworkBrowserOpenFollowUp(activeRequest);
  const builtWorkspaceReady =
    trackedWorkspaceRoot !== null &&
    hasFrameworkBuildArtifacts(kind, finalFolderPath);
  const trackedPreviewAlreadyRunning = trackedPreviewUrl !== null;
  const liveLifecycleRequested =
    liveVerificationRequested ||
    browserVerificationRequested ||
    persistentBrowserOpenRequested ||
    previewFollowUpRequested ||
    browserOpenFollowUpRequested;
  const canReuseBuiltWorkspaceForLiveLifecycle =
    builtWorkspaceReady &&
    (previewFollowUpRequested || browserOpenFollowUpRequested);
  const canReuseTrackedLivePreview =
    trackedPreviewAlreadyRunning &&
    (previewFollowUpRequested || browserOpenFollowUpRequested);
  const startCommand =
    kind === "next_js"
      ? `npm run dev -- --hostname ${loopbackTarget.host} --port ${loopbackTarget.port}`
      : `npm run preview -- --host ${loopbackTarget.host} --port ${loopbackTarget.port}`;

  const trackedLiveEditActions = buildDeterministicFrameworkTrackedEditFallbackActions({
    kind,
    activeRequest,
    finalFolderPath,
    liveUrl,
    trackedPreviewProcessLeaseId,
    trackedBrowserSessionId,
    requestedShellKind: executionEnvironment.shellKind,
    startCommand
  });
  if (trackedLiveEditActions.length > 0) {
    return trackedLiveEditActions;
  }

  const scaffoldAction: PlannedAction = {
    id: makeId("action"),
    type: "shell_command",
    description:
      "Scaffold the framework app through a package-safe temp slug, then move it into the exact requested folder.",
    params: {
      command: scaffoldCommand,
      cwd: executionEnvironment.desktopPath,
      workdir: executionEnvironment.desktopPath,
      requestedShellKind: executionEnvironment.shellKind,
      timeoutMs: 120_000
    },
    estimatedCostUsd: estimateActionCostUsd({
      type: "shell_command",
      params: { command: scaffoldCommand, cwd: executionEnvironment.desktopPath }
    })
  };

  const writeActions = buildFrameworkLandingPageWriteActions(
    kind,
    finalFolderPath,
    requestedFolderName,
    requestContext
  );

  const installAction: PlannedAction = {
    id: makeId("action"),
    type: "shell_command",
    description:
      "Install dependencies in the exact requested project folder so package.json and node_modules are present there.",
    params: {
      command: "npm install",
      cwd: finalFolderPath,
      workdir: finalFolderPath,
      requestedShellKind: executionEnvironment.shellKind,
      timeoutMs: 120_000
    },
    estimatedCostUsd: estimateActionCostUsd({
      type: "shell_command",
      params: { command: "npm install", cwd: finalFolderPath }
    })
  };

  const buildAction: PlannedAction = {
    id: makeId("action"),
    type: "shell_command",
    description: "Build the framework landing page so the live runtime has fresh artifacts.",
    params: {
      command: "npm run build",
      cwd: finalFolderPath,
      workdir: finalFolderPath,
      requestedShellKind: executionEnvironment.shellKind,
      timeoutMs: 120_000
    },
    estimatedCostUsd: estimateActionCostUsd({
      type: "shell_command",
      params: { command: "npm run build", cwd: finalFolderPath }
    })
  };

  const workspaceProofCommand =
    "$missing=@(); if (!(Test-Path '.\\package.json')) { $missing += 'package.json' }; " +
    "if (!(Test-Path '.\\node_modules')) { $missing += 'node_modules' }; " +
    "if ($missing.Count -gt 0) { throw ('Workspace not ready; missing: ' + ($missing -join ', ')) }; " +
    "Get-Item .\\package.json,.\\node_modules | Select-Object Name,FullName";
  const workspaceProofAction: PlannedAction = {
    id: makeId("action"),
    type: "shell_command",
    description:
      "Perform a finite readiness proof that the workspace now contains package.json and node_modules.",
    params: {
      command: workspaceProofCommand,
      cwd: finalFolderPath,
      workdir: finalFolderPath,
      requestedShellKind: executionEnvironment.shellKind,
      timeoutMs: 30_000
    },
    estimatedCostUsd: estimateActionCostUsd({
      type: "shell_command",
      params: { command: workspaceProofCommand, cwd: finalFolderPath }
    })
  };

  const buildProofCommand =
    kind === "next_js"
      ? [
          "$missing=@()",
          "if (!(Test-Path '.\\package.json')) { $missing += 'package.json' }",
          "if (!(Test-Path '.\\node_modules')) { $missing += 'node_modules' }",
          "if (!(Test-Path '.\\app\\page.js') -and !(Test-Path '.\\app\\page.tsx') -and !(Test-Path '.\\src\\app\\page.js') -and !(Test-Path '.\\src\\app\\page.tsx')) { $missing += 'app/page' }",
          "if (!(Test-Path '.\\.next\\BUILD_ID')) { $missing += '.next/BUILD_ID' }",
          "if ($missing.Count -gt 0) { throw ('Landing page build proof missing: ' + ($missing -join ', ')) }",
          "Get-Item .\\package.json,.\\node_modules,.\\.next\\BUILD_ID | Select-Object Name,FullName"
        ].join("; ")
      : [
          "$missing=@()",
          "if (!(Test-Path '.\\package.json')) { $missing += 'package.json' }",
          "if (!(Test-Path '.\\node_modules')) { $missing += 'node_modules' }",
          "if (!(Test-Path '.\\src\\App.jsx') -and !(Test-Path '.\\src\\App.tsx') -and !(Test-Path '.\\src\\App.js') -and !(Test-Path '.\\src\\App.ts')) { $missing += 'src/App' }",
          "if (!(Test-Path '.\\dist\\index.html')) { $missing += 'dist/index.html' }",
          "if ($missing.Count -gt 0) { throw ('Landing page build proof missing: ' + ($missing -join ', ')) }",
          "Get-Item .\\package.json,.\\node_modules,.\\dist\\index.html | Select-Object Name,FullName"
        ].join("; ");
  const buildProofAction: PlannedAction = {
    id: makeId("action"),
    type: "shell_command",
    description:
      "Perform a finite source-and-build proof for the landing page workspace before any live run.",
    params: {
      command: buildProofCommand,
      cwd: finalFolderPath,
      workdir: finalFolderPath,
      requestedShellKind: executionEnvironment.shellKind,
      timeoutMs: 30_000
    },
    estimatedCostUsd: estimateActionCostUsd({
      type: "shell_command",
      params: { command: buildProofCommand, cwd: finalFolderPath }
    })
  };

  if (!liveLifecycleRequested) {
    if (workspacePreparationOnly) {
      return [scaffoldAction, installAction, workspaceProofAction];
    }
    return [scaffoldAction, ...writeActions, installAction, buildAction, buildProofAction];
  }

  const startAction: PlannedAction = {
    id: makeId("action"),
    type: "start_process",
    description: "Start the framework app locally on loopback so it can be reviewed in the browser.",
    params: {
      command: startCommand,
      cwd: finalFolderPath,
      workdir: finalFolderPath,
      requestedShellKind: executionEnvironment.shellKind,
      timeoutMs: 120_000
    },
    estimatedCostUsd: estimateActionCostUsd({
      type: "start_process",
      params: { command: startCommand, cwd: finalFolderPath }
    })
  };

  const probeAction: PlannedAction = {
    id: makeId("action"),
    type: "probe_http",
    description: "Wait for the local framework app to answer on its loopback URL.",
    params: { url: liveUrl, expectedStatus: 200, timeoutMs: 30_000 },
    estimatedCostUsd: estimateActionCostUsd({
      type: "probe_http",
      params: { url: liveUrl, expectedStatus: 200 }
    })
  };

  const verifyAction: PlannedAction | null = browserVerificationRequested
    ? {
        id: makeId("action"),
        type: "verify_browser",
        description: "Verify the landing page browser view on the loopback app.",
        params: {
          url: liveUrl,
          expectedTitle: requestedFolderName,
          expectedText: requestedFolderName,
          timeoutMs: 30_000
        },
        estimatedCostUsd: estimateActionCostUsd({
          type: "verify_browser",
          params: {
            url: liveUrl,
            expectedTitle: requestedFolderName,
            expectedText: requestedFolderName
          }
        })
      }
    : null;

  const openBrowserAction: PlannedAction | null =
    persistentBrowserOpenRequested || browserOpenFollowUpRequested
    ? {
        id: makeId("action"),
        type: "open_browser",
        description: "Open the live landing page in a visible browser window and leave it open.",
        params: {
          url: liveUrl,
          rootPath: finalFolderPath,
          ...(trackedPreviewProcessLeaseId
            ? { previewProcessLeaseId: trackedPreviewProcessLeaseId }
            : {}),
          timeoutMs: 30_000
        },
        estimatedCostUsd: estimateActionCostUsd({
          type: "open_browser",
          params: {
            url: liveUrl,
            rootPath: finalFolderPath,
            ...(trackedPreviewProcessLeaseId
              ? { previewProcessLeaseId: trackedPreviewProcessLeaseId }
              : {})
          }
        })
      }
    : null;

  if (canReuseTrackedLivePreview) {
    return [
      probeAction,
      ...(verifyAction ? [verifyAction] : []),
      ...(openBrowserAction ? [openBrowserAction] : [])
    ];
  }

  if (canReuseBuiltWorkspaceForLiveLifecycle) {
    return [
      startAction,
      probeAction,
      ...(verifyAction ? [verifyAction] : []),
      ...(openBrowserAction ? [openBrowserAction] : [])
    ];
  }

  return [
    scaffoldAction,
    ...writeActions,
    installAction,
    buildAction,
    buildProofAction,
    startAction,
    probeAction,
    ...(verifyAction ? [verifyAction] : []),
    ...(openBrowserAction ? [openBrowserAction] : [])
  ];
}
