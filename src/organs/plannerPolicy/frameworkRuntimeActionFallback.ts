/**
 * @fileoverview Deterministic framework-app runtime fallback actions for planner timeout recovery.
 */
import { estimateActionCostUsd } from "../../core/actionCostPolicy";
import { makeId } from "../../core/ids";
import { PlannedAction } from "../../core/types";
import { PlannerExecutionEnvironmentContext } from "./executionStyleContracts";
import { extractRequestedFrameworkWorkspaceRootPath } from "./frameworkRequestPathParsing";
import {
  buildFrameworkBuildProofCommand,
  buildFrameworkScaffoldCommand,
  buildFrameworkWorkspaceProofCommand,
  extractTrackedPreviewProcessLeaseId,
  extractTrackedPreviewUrl,
  extractTrackedWorkspaceRoot,
  hasFrameworkBuildArtifacts,
  isFrameworkBrowserOpenFollowUp,
  isFrameworkPreviewFollowUp,
  resolveFrameworkFallbackKind,
  resolveFrameworkLoopbackTarget,
  resolveTrackedPreviewLoopbackTarget
} from "./frameworkRuntimeActionFallbackSupport";
import { buildDeterministicFrameworkOpenBrowserFollowUpActions } from "./frameworkRuntimeActionFallbackOpenBrowserSupport";
import { resolveTrackedFrameworkWorkspaceContext } from "./frameworkRuntimeActionFallbackTrackedContextSupport";
import { getPathModuleForPathValue } from "./frameworkPathSupport";
import { buildDeterministicFrameworkTrackedEditFallbackActions, extractTrackedBrowserSessionId } from "./frameworkRuntimeActionFallbackEditSupport";
import { resolveFrameworkFallbackRequestContext } from "./frameworkRuntimeActionFallbackGoalSupport";
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
const SUPPORTED_FRAMEWORK_FALLBACK_SHELL_KINDS = new Set([
  "powershell",
  "pwsh",
  "bash",
  "zsh",
  "wsl_bash"
]);
type SupportedFrameworkFallbackShellKind = "powershell" | "pwsh" | "bash" | "zsh" | "wsl_bash";

/** Builds deterministic bounded framework-app fallback actions for fresh scaffold/setup recovery. */
export function buildDeterministicFrameworkBuildFallbackActions(
  requestContext: string,
  executionEnvironment: PlannerExecutionEnvironmentContext | null,
  goalContext: string | null = null
): PlannedAction[] {
  if (
    !executionEnvironment ||
    !SUPPORTED_FRAMEWORK_FALLBACK_SHELL_KINDS.has(executionEnvironment.shellKind) ||
    !executionEnvironment.desktopPath
  ) {
    return [];
  }
  const trackedWorkspaceRoot = extractTrackedWorkspaceRoot(requestContext);
  const requestResolution = resolveFrameworkFallbackRequestContext(
    requestContext,
    goalContext,
    trackedWorkspaceRoot
  );
  const activeRequest = requestResolution.activeRequest;
  const explicitWorkspaceRoot = extractRequestedFrameworkWorkspaceRootPath(activeRequest);
  const requestedFolderName = requestResolution.requestedFolderName;
  const trackedWorkspaceContext = resolveTrackedFrameworkWorkspaceContext(
    trackedWorkspaceRoot,
    explicitWorkspaceRoot,
    requestedFolderName
  );
  const effectiveTrackedWorkspaceRoot =
    trackedWorkspaceContext.effectiveTrackedWorkspaceRoot;
  const trackedWorkspaceContextAccepted =
    trackedWorkspaceContext.trackedWorkspaceContextAccepted;
  const trackedPreviewUrl = trackedWorkspaceContextAccepted
    ? extractTrackedPreviewUrl(requestContext)
    : null;
  const trackedPreviewProcessLeaseId = trackedWorkspaceContextAccepted
    ? extractTrackedPreviewProcessLeaseId(requestContext)
    : null;
  const trackedBrowserSessionId = trackedWorkspaceContextAccepted
    ? extractTrackedBrowserSessionId(requestContext)
    : null;
  const directOpenBrowserFollowUpActions =
    buildDeterministicFrameworkOpenBrowserFollowUpActions(
      activeRequest,
      effectiveTrackedWorkspaceRoot,
      trackedPreviewProcessLeaseId
    );
  if (directOpenBrowserFollowUpActions.length > 0) {
    return directOpenBrowserFollowUpActions;
  }
  if (!isDeterministicFrameworkBuildLaneRequest(activeRequest)) {
    return [];
  }
  if (!requestedFolderName) {
    return [];
  }
  const requestedShellKind =
    executionEnvironment.shellKind as SupportedFrameworkFallbackShellKind;
  const targetPathModule = getPathModuleForPathValue(
    explicitWorkspaceRoot ??
      effectiveTrackedWorkspaceRoot ??
      executionEnvironment.desktopPath
  );
  const requestedFinalFolderPath = targetPathModule.join(
    executionEnvironment.desktopPath.replace(/[\\\/]+$/, ""),
    requestedFolderName
  );
  const finalFolderPath =
    explicitWorkspaceRoot ??
    (effectiveTrackedWorkspaceRoot &&
    targetPathModule.basename(effectiveTrackedWorkspaceRoot) === requestedFolderName
      ? effectiveTrackedWorkspaceRoot
      : requestedFinalFolderPath);
  const kind = resolveFrameworkFallbackKind(
    requestContext,
    effectiveTrackedWorkspaceRoot,
    finalFolderPath
  );
  const themeRequestContext = requestResolution.themeRequestContext;
  if (!kind) {
    return [];
  }
  const trackedPreviewLoopbackTarget = resolveTrackedPreviewLoopbackTarget(trackedPreviewUrl);
  const loopbackTarget =
    trackedPreviewLoopbackTarget ?? resolveFrameworkLoopbackTarget(kind, activeRequest);
  const liveUrl = loopbackTarget.url;
  const scaffoldCommand = buildFrameworkScaffoldCommand(
    kind,
    finalFolderPath,
    requestedFolderName,
    requestedShellKind
  );
  const scaffoldRequested = requiresFrameworkAppScaffoldAction(activeRequest);
  const liveVerificationRequested = isLiveVerificationBuildRequest(requestContext);
  const browserVerificationRequested =
    requiresBrowserVerificationBuildRequest(requestContext);
  const persistentBrowserOpenRequested =
    requiresPersistentBrowserOpenBuildRequest(requestContext);
  const workspacePreparationOnly =
    isFrameworkWorkspacePreparationRequest(requestContext);
  const previewFollowUpRequested = !scaffoldRequested &&
    isFrameworkPreviewFollowUp(activeRequest) &&
    !suppressesLiveRunWork(activeRequest);
  const browserOpenFollowUpRequested =
    !scaffoldRequested && isFrameworkBrowserOpenFollowUp(activeRequest);
  const builtWorkspaceReady = hasFrameworkBuildArtifacts(kind, finalFolderPath);
  const trackedPreviewAlreadyRunning = trackedPreviewUrl !== null;
  const liveLifecycleRequested =
    liveVerificationRequested ||
    browserVerificationRequested ||
    persistentBrowserOpenRequested ||
    previewFollowUpRequested ||
    browserOpenFollowUpRequested;
  const canReuseBuiltWorkspaceForLiveLifecycle =
    builtWorkspaceReady &&
    (
      previewFollowUpRequested ||
      browserOpenFollowUpRequested ||
      !scaffoldRequested
    );
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
    requestedShellKind,
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
      requestedShellKind,
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
    themeRequestContext
  );
  const installAction: PlannedAction = {
    id: makeId("action"),
    type: "shell_command",
    description:
      "Install dependencies in the exact requested project folder so package.json and node_modules are present there.",
    params: {
      command: "npm install --no-audit --no-fund",
      cwd: finalFolderPath,
      workdir: finalFolderPath,
      requestedShellKind,
      timeoutMs: 120_000
    },
    estimatedCostUsd: estimateActionCostUsd({
      type: "shell_command",
      params: { command: "npm install --no-audit --no-fund", cwd: finalFolderPath }
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
      requestedShellKind,
      timeoutMs: 120_000
    },
    estimatedCostUsd: estimateActionCostUsd({
      type: "shell_command",
      params: { command: "npm run build", cwd: finalFolderPath }
    })
  };
  const workspaceProofCommand = buildFrameworkWorkspaceProofCommand(
    requestedShellKind
  );
  const workspaceProofAction: PlannedAction = {
    id: makeId("action"),
    type: "shell_command",
    description:
      "Perform a finite readiness proof that the workspace now contains package.json and node_modules.",
    params: {
      command: workspaceProofCommand,
      cwd: finalFolderPath,
      workdir: finalFolderPath,
      requestedShellKind,
      timeoutMs: 30_000
    },
    estimatedCostUsd: estimateActionCostUsd({
      type: "shell_command",
      params: { command: workspaceProofCommand, cwd: finalFolderPath }
    })
  };
  const buildProofCommand = buildFrameworkBuildProofCommand(
    kind,
    requestedShellKind
  );
  const buildProofAction: PlannedAction = {
    id: makeId("action"),
    type: "shell_command",
    description:
      "Perform a finite source-and-build proof for the landing page workspace before any live run.",
    params: {
      command: buildProofCommand,
      cwd: finalFolderPath,
      workdir: finalFolderPath,
      requestedShellKind,
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
      requestedShellKind,
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
          ...(canReuseTrackedLivePreview && trackedPreviewProcessLeaseId
            ? { previewProcessLeaseId: trackedPreviewProcessLeaseId }
            : {}),
          timeoutMs: 30_000
        },
        estimatedCostUsd: estimateActionCostUsd({
          type: "open_browser",
          params: {
            url: liveUrl,
            rootPath: finalFolderPath,
            ...(canReuseTrackedLivePreview && trackedPreviewProcessLeaseId
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
    workspaceProofAction,
    buildAction,
    buildProofAction,
    startAction,
    probeAction,
    ...(verifyAction ? [verifyAction] : []),
    ...(openBrowserAction ? [openBrowserAction] : [])
  ];
}
