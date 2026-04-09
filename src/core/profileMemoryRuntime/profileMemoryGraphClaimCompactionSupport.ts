/**
 * @fileoverview Bounded claim-retention helpers for additive profile-memory graph state.
 */

import type {
  ProfileMemoryGraphClaimRecord,
  ProfileMemoryGraphCompactionStateV1,
  ProfileMemoryMutationJournalStateV1
} from "./profileMemoryGraphContracts";
import { isProfileMemoryGraphClaimCurrentSurfaceEligible } from "./profileMemoryGraphClaimSurfaceEligibilitySupport";

/**
 * Enforces bounded claim retention while preserving active or replay-retained graph claims.
 *
 * @param input - Current graph claims plus retained journal references.
 * @returns Compacted claim state and any compaction-state update.
 */
export function compactProfileMemoryGraphClaims(input: {
  claims: readonly ProfileMemoryGraphClaimRecord[];
  mutationJournal: ProfileMemoryMutationJournalStateV1;
  compaction: ProfileMemoryGraphCompactionStateV1;
  recordedAt: string;
}): {
  nextClaims: ProfileMemoryGraphClaimRecord[];
  nextCompaction: ProfileMemoryGraphCompactionStateV1;
  changed: boolean;
} {
  if (input.claims.length <= input.compaction.maxClaimCount) {
    return {
      nextClaims: [...input.claims],
      nextCompaction: input.compaction,
      changed: false
    };
  }

  const protectedClaimIds = collectProtectedClaimIds(input.claims, input.mutationJournal);
  const protectedClaims = input.claims.filter((claim) => protectedClaimIds.has(claim.payload.claimId));
  const removableClaims = input.claims
    .filter((claim) => !protectedClaimIds.has(claim.payload.claimId))
    .sort(compareClaimRetentionPriority);
  const targetClaimCount = Math.max(input.compaction.maxClaimCount, protectedClaims.length);
  if (input.claims.length <= targetClaimCount) {
    return {
      nextClaims: [...input.claims],
      nextCompaction: input.compaction,
      changed: false
    };
  }

  const removableCountToKeep = Math.max(0, targetClaimCount - protectedClaims.length);
  const keptRemovableClaims = removableClaims.slice(
    Math.max(0, removableClaims.length - removableCountToKeep)
  );
  const nextClaims = [...protectedClaims, ...keptRemovableClaims].sort(compareClaimRecords);

  return {
    nextClaims,
    nextCompaction: {
      ...input.compaction,
      lastCompactedAt: input.recordedAt
    },
    changed: nextClaims.length !== input.claims.length
  };
}

/**
 * Collects claim ids that must remain available because they are still active or retained by the
 * bounded replay window.
 *
 * @param claims - Canonical graph claims after the current mutation batch.
 * @param mutationJournal - Retained bounded mutation-journal state.
 * @returns Protected claim identifiers.
 */
function collectProtectedClaimIds(
  claims: readonly ProfileMemoryGraphClaimRecord[],
  mutationJournal: ProfileMemoryMutationJournalStateV1
): ReadonlySet<string> {
  return new Set([
    ...claims
      .filter(
        (claim) =>
          claim.payload.active &&
          isProfileMemoryGraphClaimCurrentSurfaceEligible(claim)
      )
      .map((claim) => claim.payload.claimId),
    ...mutationJournal.entries.flatMap((entry) => entry.claimIds)
  ]);
}

/**
 * Orders graph claims deterministically for bounded retention.
 *
 * @param left - Left claim record.
 * @param right - Right claim record.
 * @returns Stable ordering result.
 */
function compareClaimRecords(
  left: ProfileMemoryGraphClaimRecord,
  right: ProfileMemoryGraphClaimRecord
): number {
  if (left.payload.normalizedKey !== right.payload.normalizedKey) {
    return left.payload.normalizedKey.localeCompare(right.payload.normalizedKey);
  }
  return left.payload.claimId.localeCompare(right.payload.claimId);
}

/**
 * Orders removable graph claims from oldest to newest for bounded retention.
 *
 * @param left - Left claim record.
 * @param right - Right claim record.
 * @returns Stable ordering result.
 */
function compareClaimRetentionPriority(
  left: ProfileMemoryGraphClaimRecord,
  right: ProfileMemoryGraphClaimRecord
): number {
  const leftBoundary = left.payload.endedAt ??
    left.payload.validTo ??
    left.payload.validFrom ??
    left.payload.assertedAt;
  const rightBoundary = right.payload.endedAt ??
    right.payload.validTo ??
    right.payload.validFrom ??
    right.payload.assertedAt;
  if (leftBoundary !== rightBoundary) {
    return leftBoundary.localeCompare(rightBoundary);
  }
  return left.payload.claimId.localeCompare(right.payload.claimId);
}
