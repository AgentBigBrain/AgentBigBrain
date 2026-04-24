import { estimateActionCostUsd } from "../../core/actionCostPolicy";
import { makeId } from "../../core/ids";
import type { PlannedAction } from "../../core/types";

export interface FrameworkLifecycleRequestState {
  scaffoldRequested: boolean;
  liveVerificationRequested: boolean;
  browserVerificationRequested: boolean;
  persistentBrowserOpenRequested: boolean;
  workspacePreparationOnly: boolean;
  previewFollowUpRequested: boolean;
  browserOpenFollowUpRequested: boolean;
  builtWorkspaceReady: boolean;
  trackedPreviewAlreadyRunning: boolean;
  liveLifecycleRequested: boolean;
  canReuseBuiltWorkspaceForLiveLifecycle: boolean;
  canReuseTrackedLivePreview: boolean;
}

interface FrameworkLiveLifecycleActionParams {
  requestedFolderName: string;
  liveUrl: string;
  finalFolderPath: string;
  startCommand: string;
  requestedShellKind: "powershell" | "pwsh" | "bash" | "zsh" | "wsl_bash";
  browserVerificationRequested: boolean;
  persistentBrowserOpenRequested: boolean;
  browserOpenFollowUpRequested: boolean;
  canReuseTrackedLivePreview: boolean;
  trackedPreviewProcessLeaseId: string | null;
}

/**
 * Builds framework live lifecycle actions.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `estimateActionCostUsd` (import `estimateActionCostUsd`) from `../../core/actionCostPolicy`.
 * - Uses `makeId` (import `makeId`) from `../../core/ids`.
 * - Uses `PlannedAction` (import `PlannedAction`) from `../../core/types`.
 * @param params - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function buildFrameworkLiveLifecycleActions(
  params: FrameworkLiveLifecycleActionParams
): {
  startAction: PlannedAction;
  probeAction: PlannedAction;
  verifyAction: PlannedAction | null;
  openBrowserAction: PlannedAction | null;
} {
  const startAction: PlannedAction = {
    id: makeId("action"),
    type: "start_process",
    description: "Start the framework app locally on loopback so it can be reviewed in the browser.",
    params: {
      command: params.startCommand,
      cwd: params.finalFolderPath,
      workdir: params.finalFolderPath,
      requestedShellKind: params.requestedShellKind,
      timeoutMs: 120_000
    },
    estimatedCostUsd: estimateActionCostUsd({
      type: "start_process",
      params: { command: params.startCommand, cwd: params.finalFolderPath }
    })
  };

  const probeAction: PlannedAction = {
    id: makeId("action"),
    type: "probe_http",
    description: "Wait for the local framework app to answer on its loopback URL.",
    params: { url: params.liveUrl, expectedStatus: 200, timeoutMs: 30_000 },
    estimatedCostUsd: estimateActionCostUsd({
      type: "probe_http",
      params: { url: params.liveUrl, expectedStatus: 200 }
    })
  };

  const verifyAction: PlannedAction | null = params.browserVerificationRequested
    ? {
        id: makeId("action"),
        type: "verify_browser",
        description: "Verify the landing page browser view on the loopback app.",
        params: {
          url: params.liveUrl,
          expectedTitle: params.requestedFolderName,
          expectedText: params.requestedFolderName,
          timeoutMs: 30_000
        },
        estimatedCostUsd: estimateActionCostUsd({
          type: "verify_browser",
          params: {
            url: params.liveUrl,
            expectedTitle: params.requestedFolderName,
            expectedText: params.requestedFolderName
          }
        })
      }
    : null;

  const openBrowserAction: PlannedAction | null =
    params.persistentBrowserOpenRequested || params.browserOpenFollowUpRequested
      ? {
          id: makeId("action"),
          type: "open_browser",
          description: "Open the live landing page in a visible browser window and leave it open.",
          params: {
            url: params.liveUrl,
            rootPath: params.finalFolderPath,
            ...(params.canReuseTrackedLivePreview && params.trackedPreviewProcessLeaseId
              ? { previewProcessLeaseId: params.trackedPreviewProcessLeaseId }
              : {}),
            timeoutMs: 30_000
          },
          estimatedCostUsd: estimateActionCostUsd({
            type: "open_browser",
            params: {
              url: params.liveUrl,
              rootPath: params.finalFolderPath,
              ...(params.canReuseTrackedLivePreview && params.trackedPreviewProcessLeaseId
                ? { previewProcessLeaseId: params.trackedPreviewProcessLeaseId }
                : {})
            }
          })
        }
      : null;

  return { startAction, probeAction, verifyAction, openBrowserAction };
}
