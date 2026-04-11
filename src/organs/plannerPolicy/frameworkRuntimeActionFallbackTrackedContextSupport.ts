import { getPathModuleForPathValue } from "./frameworkPathSupport";

export interface FrameworkTrackedWorkspaceContext {
  readonly acceptedTrackedWorkspaceRoot: string | null;
  readonly effectiveTrackedWorkspaceRoot: string | null;
  readonly trackedWorkspaceContextAccepted: boolean;
}

/** Normalizes one filesystem path into a case-insensitive comparable key. */
function normalizeComparablePath(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
}

/**
 * Resolves whether tracked workspace continuity is still safe to reuse for the active framework
 * fallback turn.
 */
export function resolveTrackedFrameworkWorkspaceContext(
  trackedWorkspaceRoot: string | null,
  explicitWorkspaceRoot: string | null,
  requestedFolderName: string | null
): FrameworkTrackedWorkspaceContext {
  const trackedWorkspaceRootMatchesRequestedFolder =
    trackedWorkspaceRoot !== null &&
    requestedFolderName !== null &&
    getPathModuleForPathValue(trackedWorkspaceRoot).basename(trackedWorkspaceRoot) ===
      requestedFolderName;
  const acceptedTrackedWorkspaceRoot =
    trackedWorkspaceRootMatchesRequestedFolder ? trackedWorkspaceRoot : null;
  const effectiveTrackedWorkspaceRoot =
    explicitWorkspaceRoot ?? acceptedTrackedWorkspaceRoot;
  return {
    acceptedTrackedWorkspaceRoot,
    effectiveTrackedWorkspaceRoot,
    trackedWorkspaceContextAccepted:
      trackedWorkspaceRoot !== null &&
      effectiveTrackedWorkspaceRoot !== null &&
      normalizeComparablePath(trackedWorkspaceRoot) ===
        normalizeComparablePath(effectiveTrackedWorkspaceRoot)
  };
}
