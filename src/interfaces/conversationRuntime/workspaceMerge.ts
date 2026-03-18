/**
 * @fileoverview Owns active-workspace merge selection below the stable session merge entrypoint.
 */

import {
  basenameCrossPlatformPath,
  dirnameCrossPlatformPath,
  localFileUrlToAbsolutePath,
  normalizeCrossPlatformPath
} from "../../core/crossPlatformPath";
import type { ConversationActiveWorkspaceRecord } from "../sessionStore";

const GENERIC_WORKSPACE_CONTAINER_NAMES = new Set([
  "desktop",
  "documents",
  "downloads",
  "onedrive",
  "pictures",
  "videos",
  "music"
]);

/**
 * Normalizes one local path into a case-insensitive comparable identity.
 *
 * @param candidatePath - Raw local path candidate.
 * @returns Comparable normalized path, or `null` when the input is blank.
 */
function toComparablePath(candidatePath: string | null | undefined): string | null {
  if (!candidatePath) {
    return null;
  }
  const normalized = normalizeCrossPlatformPath(candidatePath);
  if (!normalized) {
    return null;
  }
  return normalized.replace(/\\/g, "/").toLowerCase();
}

/**
 * Returns whether one comparable path is the same as or nested below another.
 *
 * @param candidatePath - Candidate child or same path.
 * @param rootPath - Candidate parent path.
 * @returns `true` when the candidate path is the same as or nested below the root.
 */
function isSameOrNestedComparablePath(
  candidatePath: string | null,
  rootPath: string | null
): boolean {
  if (!candidatePath || !rootPath) {
    return false;
  }
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`);
}

/**
 * Returns whether a remembered workspace root is specific enough to anchor continuity matching.
 *
 * @param workspace - Workspace snapshot under evaluation.
 * @returns `true` when the remembered root is project-specific rather than a generic container.
 */
function hasReliableWorkspaceRoot(
  workspace: ConversationActiveWorkspaceRecord
): boolean {
  if (!workspace.rootPath) {
    return false;
  }
  const basename = basenameCrossPlatformPath(workspace.rootPath).toLowerCase();
  if (!GENERIC_WORKSPACE_CONTAINER_NAMES.has(basename)) {
    return true;
  }
  return workspace.lastChangedPaths.some((entry) => {
    const parent = dirnameCrossPlatformPath(entry);
    return parent.length > 0 && normalizeCrossPlatformPath(parent) !== normalizeCrossPlatformPath(workspace.rootPath ?? "");
  });
}

/**
 * Builds strong path identities used to decide whether two workspace snapshots belong together.
 *
 * @param workspace - Workspace snapshot under evaluation.
 * @returns Strong path identities for continuity matching.
 */
function buildStrongWorkspaceIdentityPaths(
  workspace: ConversationActiveWorkspaceRecord
): string[] {
  return [
    workspace.primaryArtifactPath,
    ...workspace.lastChangedPaths,
    localFileUrlToAbsolutePath(workspace.previewUrl ?? "")
  ]
    .map((entry) => toComparablePath(entry))
    .filter((entry): entry is string => entry !== null);
}

/**
 * Returns whether a newer workspace snapshot should inherit continuity fields from an older one.
 *
 * @param preferred - Newer preferred workspace snapshot.
 * @param fallback - Older fallback workspace snapshot.
 * @returns `true` when backfilling continuity fields is safe.
 */
function shouldBackfillWorkspaceContinuity(
  preferred: ConversationActiveWorkspaceRecord,
  fallback: ConversationActiveWorkspaceRecord
): boolean {
  if (!preferred.sourceJobId || preferred.sourceJobId === fallback.sourceJobId) {
    return true;
  }
  if (
    preferred.browserSessionId &&
    fallback.browserSessionIds.includes(preferred.browserSessionId)
  ) {
    return true;
  }

  const preferredStrongPaths = buildStrongWorkspaceIdentityPaths(preferred);
  const fallbackStrongPaths = buildStrongWorkspaceIdentityPaths(fallback);
  if (
    preferredStrongPaths.some((entry) => fallbackStrongPaths.includes(entry))
  ) {
    return true;
  }

  if (!hasReliableWorkspaceRoot(preferred) || !hasReliableWorkspaceRoot(fallback)) {
    return false;
  }

  const preferredRoot = toComparablePath(preferred.rootPath);
  const fallbackRoot = toComparablePath(fallback.rootPath);
  if (!preferredRoot || !fallbackRoot) {
    return false;
  }
  if (preferredRoot === fallbackRoot) {
    return true;
  }
  return (
    preferredStrongPaths.some((entry) => isSameOrNestedComparablePath(entry, fallbackRoot)) ||
    fallbackStrongPaths.some((entry) => isSameOrNestedComparablePath(entry, preferredRoot))
  );
}

/**
 * Chooses the newer active workspace snapshot while backfilling missing continuity fields.
 *
 * @param existing - Previously persisted active workspace snapshot.
 * @param incoming - Newly persisted active workspace snapshot.
 * @returns Preferred active workspace snapshot after continuity backfill.
 */
export function selectActiveWorkspace(
  existing: ConversationActiveWorkspaceRecord | null | undefined,
  incoming: ConversationActiveWorkspaceRecord | null | undefined
): ConversationActiveWorkspaceRecord | null {
  if (!existing) {
    return incoming ?? null;
  }
  if (!incoming) {
    return existing;
  }
  const preferred = incoming.updatedAt >= existing.updatedAt ? incoming : existing;
  const fallback = preferred === incoming ? existing : incoming;
  if (!shouldBackfillWorkspaceContinuity(preferred, fallback)) {
    return preferred;
  }
  const browserSessionIds = preferred.browserSessionIds.length > 0
    ? preferred.browserSessionIds
    : fallback.browserSessionIds;
  const previewProcessLeaseIds = preferred.previewProcessLeaseIds.length > 0
    ? preferred.previewProcessLeaseIds
    : fallback.previewProcessLeaseIds;
  return {
    ...preferred,
    rootPath: preferred.rootPath ?? fallback.rootPath ?? null,
    primaryArtifactPath:
      preferred.primaryArtifactPath ?? fallback.primaryArtifactPath ?? null,
    previewUrl: preferred.previewUrl ?? fallback.previewUrl ?? null,
    browserSessionId: preferred.browserSessionId ?? fallback.browserSessionId ?? null,
    browserSessionIds,
    browserSessionStatus:
      preferred.browserSessionStatus ?? fallback.browserSessionStatus ?? null,
    browserProcessPid:
      preferred.browserProcessPid ?? fallback.browserProcessPid ?? null,
    previewProcessLeaseId:
      preferred.previewProcessLeaseId ?? fallback.previewProcessLeaseId ?? null,
    previewProcessLeaseIds,
    previewProcessCwd:
      preferred.previewProcessCwd ?? fallback.previewProcessCwd ?? null,
    lastKnownPreviewProcessPid:
      preferred.lastKnownPreviewProcessPid ?? fallback.lastKnownPreviewProcessPid ?? null,
    stillControllable: preferred.stillControllable,
    ownershipState: preferred.ownershipState,
    previewStackState: preferred.previewStackState,
    lastChangedPaths:
      preferred.lastChangedPaths.length > 0
        ? preferred.lastChangedPaths
        : fallback.lastChangedPaths
  };
}
