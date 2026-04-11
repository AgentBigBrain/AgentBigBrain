import { estimateActionCostUsd } from "../../core/actionCostPolicy";
import { makeId } from "../../core/ids";
import { PlannedAction } from "../../core/types";
import { extractRequestedFrameworkWorkspaceRootPath } from "./frameworkRequestPathParsing";

const DIRECT_OPEN_BROWSER_REQUEST_PATTERN = /^\s*open_browser\b/i;
const DIRECT_OPEN_BROWSER_URL_PATTERN =
  /\burl=(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+))/i;
const DIRECT_OPEN_BROWSER_PREVIEW_LEASE_PATTERN =
  /\bpreviewProcessLeaseId=(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+))/i;

/** Extracts one inline action param value from a machine-generated fallback request. */
function extractInlineActionParam(
  request: string,
  pattern: RegExp
): string | null {
  const match = request.match(pattern);
  const rawValue = match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
  const trimmedValue = rawValue?.trim() ?? "";
  return trimmedValue.length > 0 ? trimmedValue : null;
}

/**
 * Builds the bounded browser-open follow-up for an already-proven live framework preview.
 *
 * This path must stay outside the broader build-lane gate because the machine-generated
 * follow-up request is already narrowed to a single open_browser action.
 */
export function buildDeterministicFrameworkOpenBrowserFollowUpActions(
  activeRequest: string,
  fallbackRootPath: string | null,
  fallbackPreviewProcessLeaseId: string | null
): PlannedAction[] {
  if (!DIRECT_OPEN_BROWSER_REQUEST_PATTERN.test(activeRequest)) {
    return [];
  }
  const url = extractInlineActionParam(activeRequest, DIRECT_OPEN_BROWSER_URL_PATTERN);
  const rootPath =
    extractRequestedFrameworkWorkspaceRootPath(activeRequest) ?? fallbackRootPath;
  if (!url || !rootPath) {
    return [];
  }
  const previewProcessLeaseId =
    extractInlineActionParam(activeRequest, DIRECT_OPEN_BROWSER_PREVIEW_LEASE_PATTERN) ??
    fallbackPreviewProcessLeaseId;
  const params = {
    url,
    rootPath,
    ...(previewProcessLeaseId ? { previewProcessLeaseId } : {}),
    timeoutMs: 30_000
  };
  return [
    {
      id: makeId("action"),
      type: "open_browser",
      description:
        "Open the exact live preview in a visible browser window without re-entering the build lifecycle.",
      params,
      estimatedCostUsd: estimateActionCostUsd({
        type: "open_browser",
        params
      })
    }
  ];
}
