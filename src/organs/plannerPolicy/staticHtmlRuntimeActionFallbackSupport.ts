import { extractSemanticRequestSegment } from "../../core/currentRequestExtraction";
import { parseExplicitExecutionConstraints } from "../../core/explicitExecutionConstraints";
import type { PlannerExecutionEnvironmentContext } from "./executionStyleContracts";
import { extractRequestedFrameworkFolderName } from "./frameworkBuildActionHeuristics";
import { getPathModuleForPathValue } from "./frameworkPathSupport";
import { extractRequestedFrameworkWorkspaceRootPath } from "./frameworkRequestPathParsing";
import {
  requiresBrowserVerificationBuildRequest,
  requiresPersistentBrowserOpenBuildRequest
} from "./liveVerificationPolicy";

const STATIC_HTML_BUILD_LANE_PATTERN = /\bExecution lane:\s*static_html_build\b/i;
const TRACKED_WORKSPACE_ROOT_PATTERN =
  /(?:^|\n)-\s+(?:Root path|Workspace root):\s+([^\r\n]+)\s*$/im;
const TRACKED_WORKSPACE_REFERENCE_PATTERN =
  /\b(?:reuse|existing|current|same|tracked|that|this)\b/i;
const DOCUMENTS_DESTINATION_PATTERN = /\bdocuments\b/i;
const DOWNLOADS_DESTINATION_PATTERN = /\bdownloads\b/i;
const STATIC_HTML_BROWSER_OPEN_INTENT_PATTERN =
  /\b(?:open|reopen|show|bring\s+(?:back|up)|pull\s+up)\b[\s\S]{0,120}\b(?:browser|review|view|see|file)\b/i;

/**
 * Converts to title case.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function toTitleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Slugifies folder name.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function slugifyFolderName(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/\.+$/g, "")
    .trim();
}

/**
 * Resolves tracked workspace root.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param requestContext - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function resolveTrackedWorkspaceRoot(requestContext: string): string | null {
  const trackedRoot =
    requestContext.match(TRACKED_WORKSPACE_ROOT_PATTERN)?.[1]?.trim() ?? null;
  return trackedRoot && trackedRoot.length > 0 ? trackedRoot : null;
}

/**
 * Evaluates whether tracked workspace root.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param activeRequest - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function prefersTrackedWorkspaceRoot(activeRequest: string): boolean {
  return TRACKED_WORKSPACE_REFERENCE_PATTERN.test(activeRequest);
}

/**
 * Resolves destination base path.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `PlannerExecutionEnvironmentContext` (import `PlannerExecutionEnvironmentContext`) from `./executionStyleContracts`.
 * @param activeRequest - Input consumed by this helper.
 * @param executionEnvironment - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function resolveDestinationBasePath(
  activeRequest: string,
  executionEnvironment: PlannerExecutionEnvironmentContext
): string | null {
  if (DOWNLOADS_DESTINATION_PATTERN.test(activeRequest)) {
    return executionEnvironment.downloadsPath ?? executionEnvironment.desktopPath;
  }
  if (DOCUMENTS_DESTINATION_PATTERN.test(activeRequest)) {
    return executionEnvironment.documentsPath ?? executionEnvironment.desktopPath;
  }
  return (
    executionEnvironment.desktopPath ??
    executionEnvironment.documentsPath ??
    executionEnvironment.downloadsPath
  );
}

/**
 * Resolves static html app title.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param activeRequest - Input consumed by this helper.
 * @param requestedFolderName - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function resolveStaticHtmlAppTitle(
  activeRequest: string,
  requestedFolderName: string | null
): string {
  if (requestedFolderName && !/\blanding\s+page\b/i.test(requestedFolderName)) {
    return toTitleCase(requestedFolderName);
  }
  if (/\bsolar\b|\bclean\s+energy\b|\brenewable\b/i.test(activeRequest)) {
    return "HelioGrid";
  }
  if (/\bdrone\b|\baerial\b|\buav\b/i.test(activeRequest)) {
    return "Skyline Drones";
  }
  if (/\bdetroit\b|\bcity\b|\burban\b/i.test(activeRequest)) {
    return "Marquee City";
  }
  return "Northline Studio";
}

/**
 * Resolves static html folder name.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `extractRequestedFrameworkFolderName` (import `extractRequestedFrameworkFolderName`) from `./frameworkBuildActionHeuristics`.
 * @param activeRequest - Input consumed by this helper.
 * @param goalRequest - Input consumed by this helper.
 * @param appTitle - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function resolveStaticHtmlFolderName(
  activeRequest: string,
  goalRequest: string,
  appTitle: string
): string {
  const requestedFolderName =
    extractRequestedFrameworkFolderName(activeRequest) ??
    (goalRequest.length > 0 ? extractRequestedFrameworkFolderName(goalRequest) : null);
  if (requestedFolderName) {
    return slugifyFolderName(requestedFolderName);
  }
  return slugifyFolderName(`${appTitle} Landing Page`);
}

/**
 * Evaluates whether static html build lane marker.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param requestContext - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function hasStaticHtmlBuildLaneMarker(requestContext: string): boolean {
  return STATIC_HTML_BUILD_LANE_PATTERN.test(requestContext);
}

/**
 * Resolves static html workspace root.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `extractSemanticRequestSegment` (import `extractSemanticRequestSegment`) from `../../core/currentRequestExtraction`.
 * - Uses `PlannerExecutionEnvironmentContext` (import `PlannerExecutionEnvironmentContext`) from `./executionStyleContracts`.
 * - Uses `extractRequestedFrameworkFolderName` (import `extractRequestedFrameworkFolderName`) from `./frameworkBuildActionHeuristics`.
 * - Uses `getPathModuleForPathValue` (import `getPathModuleForPathValue`) from `./frameworkPathSupport`.
 * - Uses `extractRequestedFrameworkWorkspaceRootPath` (import `extractRequestedFrameworkWorkspaceRootPath`) from `./frameworkRequestPathParsing`.
 * @param requestContext - Input consumed by this helper.
 * @param goalContext - Input consumed by this helper.
 * @param executionEnvironment - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function resolveStaticHtmlWorkspaceRoot(
  requestContext: string,
  goalContext: string | null,
  executionEnvironment: PlannerExecutionEnvironmentContext
): { rootPath: string | null; folderName: string | null; appTitle: string | null } {
  const activeRequest = extractSemanticRequestSegment(requestContext).trim();
  const goalRequest =
    typeof goalContext === "string" ? extractSemanticRequestSegment(goalContext).trim() : "";
  const explicitWorkspaceRoot =
    extractRequestedFrameworkWorkspaceRootPath(activeRequest) ??
    (goalRequest.length > 0
      ? extractRequestedFrameworkWorkspaceRootPath(goalRequest)
      : null);
  const trackedWorkspaceRoot = resolveTrackedWorkspaceRoot(requestContext);
  const destinationBasePath = resolveDestinationBasePath(activeRequest, executionEnvironment);
  const requestedFolderName =
    extractRequestedFrameworkFolderName(activeRequest) ??
    (goalRequest.length > 0 ? extractRequestedFrameworkFolderName(goalRequest) : null);
  const appTitle = resolveStaticHtmlAppTitle(activeRequest || goalRequest, requestedFolderName);
  const folderName = resolveStaticHtmlFolderName(activeRequest, goalRequest, appTitle);
  const pathModule = getPathModuleForPathValue(
    explicitWorkspaceRoot ??
      trackedWorkspaceRoot ??
      destinationBasePath ??
      executionEnvironment.desktopPath ??
      "C:\\"
  );

  if (explicitWorkspaceRoot) {
    return {
      rootPath: explicitWorkspaceRoot,
      folderName: requestedFolderName ?? pathModule.basename(explicitWorkspaceRoot),
      appTitle
    };
  }

  if (trackedWorkspaceRoot && prefersTrackedWorkspaceRoot(activeRequest)) {
    return {
      rootPath: trackedWorkspaceRoot,
      folderName: pathModule.basename(trackedWorkspaceRoot),
      appTitle
    };
  }

  if (!destinationBasePath) {
    return {
      rootPath: null,
      folderName,
      appTitle
    };
  }

  return {
    rootPath: pathModule.join(destinationBasePath, folderName),
    folderName,
    appTitle
  };
}

/**
 * Evaluates whether open static html browser.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `parseExplicitExecutionConstraints` (import `parseExplicitExecutionConstraints`) from `../../core/explicitExecutionConstraints`.
 * - Uses `requiresBrowserVerificationBuildRequest` (import `requiresBrowserVerificationBuildRequest`) from `./liveVerificationPolicy`.
 * - Uses `requiresPersistentBrowserOpenBuildRequest` (import `requiresPersistentBrowserOpenBuildRequest`) from `./liveVerificationPolicy`.
 * @param activeRequest - Input consumed by this helper.
 * @param requestContext - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function shouldOpenStaticHtmlBrowser(
  activeRequest: string,
  requestContext: string
): boolean {
  const explicitConstraints = parseExplicitExecutionConstraints(activeRequest);
  if (explicitConstraints.disallowVisibleBrowserOpen) {
    return false;
  }

  return (
    requiresPersistentBrowserOpenBuildRequest(activeRequest) ||
    requiresBrowserVerificationBuildRequest(activeRequest) ||
    (hasStaticHtmlBuildLaneMarker(requestContext) &&
      STATIC_HTML_BROWSER_OPEN_INTENT_PATTERN.test(activeRequest))
  );
}
