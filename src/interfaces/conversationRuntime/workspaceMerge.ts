/**
 * @fileoverview Owns active-workspace merge selection below the stable session merge entrypoint.
 */

import type { ConversationActiveWorkspaceRecord } from "../sessionStore";

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
