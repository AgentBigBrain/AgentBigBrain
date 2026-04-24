import { pathToFileURL } from "node:url";

import { estimateActionCostUsd } from "../../core/actionCostPolicy";
import { dirnameCrossPlatformPath } from "../../core/crossPlatformPath";
import { extractExecutionContextPayload } from "../../core/currentRequestExtraction";
import { makeId } from "../../core/ids";
import { PlannedAction } from "../../core/types";
import { ExecutionStyleBuildPlanAssessment } from "./executionStyleContracts";

const STATIC_ARTIFACT_OPEN_CONTEXT_PATTERN =
  /\bExisting local static-artifact open follow-up:/i;
const STATIC_ARTIFACT_PREFERRED_ARTIFACT_PATH_LINE_PATTERN =
  /^-\s*Preferred artifact path:\s*(.+)$/im;
const STATIC_ARTIFACT_PREFERRED_BROWSER_TARGET_LINE_PATTERN =
  /^-\s*Preferred browser target:\s*(.+)$/im;
const STATIC_ARTIFACT_PREFERRED_ROOT_PATH_LINE_PATTERN =
  /^-\s*Preferred root path for browser ownership:\s*(.+)$/im;

interface StaticArtifactOpenContext {
  readonly preferredArtifactPath: string | null;
  readonly preferredBrowserTarget: string;
  readonly preferredRootPath: string | null;
}

/**
 * Extracts the exact already-built local artifact target from conversation-aware execution input.
 */
export function extractStaticArtifactOpenContext(
  fullExecutionInput: string
): StaticArtifactOpenContext | null {
  const normalizedExecutionInput = extractExecutionContextPayload(fullExecutionInput);
  if (!STATIC_ARTIFACT_OPEN_CONTEXT_PATTERN.test(normalizedExecutionInput)) {
    return null;
  }
  const preferredArtifactPath =
    normalizedExecutionInput
      .match(STATIC_ARTIFACT_PREFERRED_ARTIFACT_PATH_LINE_PATTERN)?.[1]
      ?.trim() ?? null;
  const preferredBrowserTarget =
    normalizedExecutionInput
      .match(STATIC_ARTIFACT_PREFERRED_BROWSER_TARGET_LINE_PATTERN)?.[1]
      ?.trim() ??
    (preferredArtifactPath
      ? pathToFileURL(preferredArtifactPath).toString()
      : null);
  if (!preferredBrowserTarget) {
    return null;
  }
  const preferredRootPath =
    normalizedExecutionInput
      .match(STATIC_ARTIFACT_PREFERRED_ROOT_PATH_LINE_PATTERN)?.[1]
      ?.trim() ??
    (preferredArtifactPath
      ? dirnameCrossPlatformPath(preferredArtifactPath)
      : null);
  return {
    preferredArtifactPath,
    preferredBrowserTarget,
    preferredRootPath:
      preferredRootPath && preferredRootPath.length > 0 ? preferredRootPath : null
  };
}

/**
 * Evaluates whether a static-artifact open follow-up tried to do anything beyond opening the file.
 */
export function hasUnsupportedStaticArtifactOpenActions(
  actions: readonly PlannedAction[],
  fullExecutionInput: string
): boolean {
  return (
    extractStaticArtifactOpenContext(fullExecutionInput) !== null &&
    actions.some((action) => action.type !== "open_browser")
  );
}

/**
 * Evaluates whether the plan opens the exact preferred local file target with the correct root.
 */
export function hasExactStaticArtifactOpenBrowserTarget(
  actions: readonly PlannedAction[],
  fullExecutionInput: string
): boolean {
  const staticArtifactOpenContext =
    extractStaticArtifactOpenContext(fullExecutionInput);
  if (!staticArtifactOpenContext) {
    return false;
  }
  return actions.some((action) => {
    if (action.type !== "open_browser") {
      return false;
    }
    const targetUrl =
      typeof action.params.url === "string" ? action.params.url.trim() : "";
    if (targetUrl !== staticArtifactOpenContext.preferredBrowserTarget) {
      return false;
    }
    if (!staticArtifactOpenContext.preferredRootPath) {
      return true;
    }
    const rootPath =
      typeof action.params.rootPath === "string" ? action.params.rootPath.trim() : "";
    return rootPath === staticArtifactOpenContext.preferredRootPath;
  });
}

/**
 * Evaluates the exact local static-artifact reopen contract when that context is present.
 */
export function assessStaticArtifactOpenPlan(
  actions: readonly PlannedAction[],
  fullExecutionInput: string
): ExecutionStyleBuildPlanAssessment | null {
  if (!extractStaticArtifactOpenContext(fullExecutionInput)) {
    return null;
  }
  if (hasUnsupportedStaticArtifactOpenActions(actions, fullExecutionInput)) {
    return {
      valid: false,
      issueCode: "STATIC_ARTIFACT_OPEN_BROWSER_ONLY_REQUIRED"
    };
  }
  if (!hasExactStaticArtifactOpenBrowserTarget(actions, fullExecutionInput)) {
    return {
      valid: false,
      issueCode: "OPEN_BROWSER_HTTP_URL_REQUIRED"
    };
  }
  return {
    valid: true,
    issueCode: null
  };
}

/**
 * Builds the deterministic open-browser action for an already-built local static artifact.
 */
export function buildDeterministicStaticArtifactOpenBrowserFallbackActions(
  fullExecutionInput: string
): PlannedAction[] {
  const staticArtifactOpenContext =
    extractStaticArtifactOpenContext(fullExecutionInput);
  if (!staticArtifactOpenContext) {
    return [];
  }
  const params = {
    url: staticArtifactOpenContext.preferredBrowserTarget,
    ...(staticArtifactOpenContext.preferredRootPath
      ? { rootPath: staticArtifactOpenContext.preferredRootPath }
      : {}),
    timeoutMs: 30_000
  };
  return [
    {
      id: makeId("action"),
      type: "open_browser",
      description:
        "Open the exact already-built local static artifact in a visible browser window without rebuilding or starting a server.",
      params,
      estimatedCostUsd: estimateActionCostUsd({
        type: "open_browser",
        params
      })
    }
  ];
}
