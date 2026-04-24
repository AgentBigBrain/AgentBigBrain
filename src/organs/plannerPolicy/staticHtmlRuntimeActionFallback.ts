/**
 * @fileoverview Deterministic static HTML runtime fallback actions for bounded landing-page builds.
 */

import { pathToFileURL } from "node:url";

import { estimateActionCostUsd } from "../../core/actionCostPolicy";
import { extractSemanticRequestSegment } from "../../core/currentRequestExtraction";
import { makeId } from "../../core/ids";
import { PlannedAction } from "../../core/types";
import type { PlannerExecutionEnvironmentContext } from "./executionStyleContracts";
import { getPathModuleForPathValue } from "./frameworkPathSupport";
import { isStaticHtmlExecutionStyleRequest } from "./liveVerificationPolicy";
import { buildStaticHtmlContent } from "./staticHtmlRuntimeActionFallbackContent";
import {
  hasStaticHtmlBuildLaneMarker,
  resolveStaticHtmlWorkspaceRoot,
  shouldOpenStaticHtmlBrowser
} from "./staticHtmlRuntimeActionFallbackSupport";

export { hasStaticHtmlBuildLaneMarker } from "./staticHtmlRuntimeActionFallbackSupport";

/**
 * Builds deterministic static html build fallback actions.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `estimateActionCostUsd` (import `estimateActionCostUsd`) from `../../core/actionCostPolicy`.
 * - Uses `extractSemanticRequestSegment` (import `extractSemanticRequestSegment`) from `../../core/currentRequestExtraction`.
 * - Uses `makeId` (import `makeId`) from `../../core/ids`.
 * - Uses `PlannedAction` (import `PlannedAction`) from `../../core/types`.
 * - Uses `PlannerExecutionEnvironmentContext` (import `PlannerExecutionEnvironmentContext`) from `./executionStyleContracts`.
 * - Uses `getPathModuleForPathValue` (import `getPathModuleForPathValue`) from `./frameworkPathSupport`.
 * - Uses `isStaticHtmlExecutionStyleRequest` (import `isStaticHtmlExecutionStyleRequest`) from `./liveVerificationPolicy`.
 * - Uses `buildStaticHtmlContent` (import `buildStaticHtmlContent`) from `./staticHtmlRuntimeActionFallbackContent`.
 * - Uses `hasStaticHtmlBuildLaneMarker` (import `hasStaticHtmlBuildLaneMarker`) from `./staticHtmlRuntimeActionFallbackSupport`.
 * - Uses `resolveStaticHtmlWorkspaceRoot` (import `resolveStaticHtmlWorkspaceRoot`) from `./staticHtmlRuntimeActionFallbackSupport`.
 * - Uses `shouldOpenStaticHtmlBrowser` (import `shouldOpenStaticHtmlBrowser`) from `./staticHtmlRuntimeActionFallbackSupport`.
 * - Uses `pathToFileURL` (import `pathToFileURL`) from `node:url`.
 * @param requestContext - Input consumed by this helper.
 * @param executionEnvironment - Input consumed by this helper.
 * @param goalContext - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function buildDeterministicStaticHtmlBuildFallbackActions(
  requestContext: string,
  executionEnvironment: PlannerExecutionEnvironmentContext | null,
  goalContext: string | null = null
): PlannedAction[] {
  if (!executionEnvironment) {
    return [];
  }
  if (
    !hasStaticHtmlBuildLaneMarker(requestContext) &&
    !isStaticHtmlExecutionStyleRequest(requestContext)
  ) {
    return [];
  }

  const activeRequest = extractSemanticRequestSegment(requestContext).trim();
  const workspaceContext = resolveStaticHtmlWorkspaceRoot(
    requestContext,
    goalContext,
    executionEnvironment
  );
  if (!workspaceContext.rootPath || !workspaceContext.folderName || !workspaceContext.appTitle) {
    return [];
  }

  const pathModule = getPathModuleForPathValue(workspaceContext.rootPath);
  const indexHtmlPath = pathModule.join(workspaceContext.rootPath, "index.html");
  const htmlContent = buildStaticHtmlContent(
    activeRequest || goalContext || "",
    workspaceContext.appTitle
  );

  const writeAction: PlannedAction = {
    id: makeId("action"),
    type: "write_file",
    description:
      "Write a single self-contained static HTML landing page into the exact requested workspace root.",
    params: {
      path: indexHtmlPath,
      content: htmlContent
    },
    estimatedCostUsd: estimateActionCostUsd({
      type: "write_file",
      params: {
        path: indexHtmlPath,
        content: htmlContent
      }
    })
  };

  const listAction: PlannedAction = {
    id: makeId("action"),
    type: "list_directory",
    description:
      "Verify the static landing page workspace now contains the generated index.html file.",
    params: {
      path: workspaceContext.rootPath
    },
    estimatedCostUsd: estimateActionCostUsd({
      type: "list_directory",
      params: {
        path: workspaceContext.rootPath
      }
    })
  };

  if (!shouldOpenStaticHtmlBrowser(activeRequest, requestContext)) {
    return [writeAction, listAction];
  }

  const fileUrl = pathToFileURL(indexHtmlPath).toString();
  const openAction: PlannedAction = {
    id: makeId("action"),
    type: "open_browser",
    description:
      "Open the generated local static HTML landing page directly from disk in a visible browser window.",
    params: {
      url: fileUrl,
      rootPath: workspaceContext.rootPath,
      timeoutMs: 30_000
    },
    estimatedCostUsd: estimateActionCostUsd({
      type: "open_browser",
      params: {
        url: fileUrl,
        rootPath: workspaceContext.rootPath
      }
    })
  };
  return [writeAction, listAction, openAction];
}
