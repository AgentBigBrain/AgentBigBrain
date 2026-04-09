/**
 * @fileoverview Fail-closed semantic-duplicate active-claim repair for additive profile-memory graph state.
 */

import { createSchemaEnvelopeV1 } from "../schemaEnvelope";
import {
  PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME
} from "./profileMemoryGraphContracts";
import type {
  ProfileMemoryGraphClaimRecord
} from "./profileMemoryGraphContracts";
import { isProfileMemoryGraphClaimCurrentSurfaceEligible } from "./profileMemoryGraphClaimSurfaceEligibilitySupport";

/**
 * Repairs malformed semantic-duplicate active claims before derived indexes and read models rebuild.
 *
 * **Why it exists:**
 * Exact duplicate active claims for the same family, key, and value are malformed retained state,
 * not true current-state disagreement. Repairing them before index and read-model rebuild keeps one
 * canonical active claim while preserving the duplicate records as inactive audit history so retained
 * journal refs do not dangle.
 *
 * **What it talks to:**
 * - Uses `createSchemaEnvelopeV1` (import `createSchemaEnvelopeV1`) from `../schemaEnvelope`.
 * - Uses `PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME` (import `PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME`) from `./profileMemoryGraphContracts`.
 * - Uses `ProfileMemoryGraphClaimRecord` (import type `ProfileMemoryGraphClaimRecord`) from `./profileMemoryGraphContracts`.
 *
 * @param input - Canonical claim records plus the deterministic repair timestamp.
 * @returns Repaired claim collection and whether semantic-duplicate repair changed anything.
 */
export function repairProfileMemoryGraphSemanticDuplicateClaims(input: {
  claims: readonly ProfileMemoryGraphClaimRecord[];
  recordedAt: string;
}): {
  nextClaims: ProfileMemoryGraphClaimRecord[];
  changed: boolean;
} {
  const duplicateGroups = collectSemanticDuplicateActiveClaimGroups(input.claims);
  if (duplicateGroups.length === 0) {
    return {
      nextClaims: [...input.claims],
      changed: false
    };
  }

  const repairedClaimMap = new Map(
    input.claims.map((claim) => [claim.payload.claimId, claim] as const)
  );
  let changed = false;

  for (const group of duplicateGroups) {
    const winner = selectSemanticDuplicateWinner(group);
    const mergedWinner = mergeSemanticDuplicateWinner(group, winner, input.recordedAt);
    if (!graphClaimRecordsEqual(mergedWinner, winner)) {
      repairedClaimMap.set(mergedWinner.payload.claimId, mergedWinner);
      changed = true;
    }

    for (const claim of group) {
      if (claim.payload.claimId === winner.payload.claimId) {
        continue;
      }
      const closedClaim = closeSemanticDuplicateClaim({
        claim,
        winner,
        recordedAt: input.recordedAt
      });
      if (!graphClaimRecordsEqual(closedClaim, claim)) {
        repairedClaimMap.set(closedClaim.payload.claimId, closedClaim);
        changed = true;
      }
    }
  }

  return {
    nextClaims: [...repairedClaimMap.values()].sort(compareClaimRecords),
    changed
  };
}

/**
 * Collects malformed semantic-duplicate active-claim groups that should collapse to one winner.
 *
 * **Why it exists:**
 * The normalization path only wants to repair exact semantic duplicates. Grouping claims up front
 * keeps true same-key disagreements on different values untouched so later read-model code can still
 * fail closed on them.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param claims - Canonical claim records after schema-envelope validation.
 * @returns Duplicate active-claim groups keyed by family, key, and value.
 */
function collectSemanticDuplicateActiveClaimGroups(
  claims: readonly ProfileMemoryGraphClaimRecord[]
): ProfileMemoryGraphClaimRecord[][] {
  const groups = new Map<string, ProfileMemoryGraphClaimRecord[]>();
  for (const claim of claims) {
    if (!isSemanticDuplicateRepairCandidate(claim)) {
      continue;
    }
    const groupKey = buildSemanticDuplicateGroupKey(claim);
    const bucket = groups.get(groupKey) ?? [];
    bucket.push(claim);
    groups.set(groupKey, bucket);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

/**
 * Checks whether one claim is eligible for semantic-duplicate repair.
 *
 * **Why it exists:**
 * Duplicate repair must stay narrow. Only active, non-redacted claims participate so inactive or
 * already-redacted history is preserved verbatim.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param claim - Candidate graph claim record.
 * @returns `true` when the claim belongs on the semantic-duplicate repair lane.
 */
function isSemanticDuplicateRepairCandidate(claim: ProfileMemoryGraphClaimRecord): boolean {
  return (
    claim.payload.active &&
    claim.payload.redactionState !== "redacted" &&
    isProfileMemoryGraphClaimCurrentSurfaceEligible(claim)
  );
}

/**
 * Builds the semantic-duplicate group key for one active claim.
 *
 * **Why it exists:**
 * The repair lane is intentionally narrower than normalized-key conflict handling. It only collapses
 * claims that already agree on family, key, and value.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param claim - Active non-redacted claim record.
 * @returns Stable group key for semantic-duplicate repair.
 */
function buildSemanticDuplicateGroupKey(claim: ProfileMemoryGraphClaimRecord): string {
  return [
    claim.payload.family,
    claim.payload.normalizedKey,
    claim.payload.normalizedValue ?? ""
  ].join("\u0000");
}

/**
 * Selects the canonical active winner from one semantic-duplicate claim group.
 *
 * **Why it exists:**
 * Duplicate repair must be deterministic so repeated loads of the same persisted state do not churn
 * claim identity. The freshest claim wins, with stable lexical fallbacks.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param claims - Semantic-duplicate active claims.
 * @returns Deterministic winner claim.
 */
function selectSemanticDuplicateWinner(
  claims: readonly ProfileMemoryGraphClaimRecord[]
): ProfileMemoryGraphClaimRecord {
  let winner = claims[0]!;
  for (const claim of claims.slice(1)) {
    if (compareClaimFreshness(claim, winner) > 0) {
      winner = claim;
    }
  }
  return winner;
}

/**
 * Merges supporting lineage from duplicate claims into the canonical active winner.
 *
 * **Why it exists:**
 * Keeping one winner should not discard supporting observation lineage, but it also should not let
 * loser-side projection, entity, or provenance metadata leak onto the surviving active winner.
 * Live fact-backed current-claim mutation only carries rebuilt observation support plus the
 * canonical winner fact id, so duplicate repair must fail closed on those non-observation refs.
 *
 * **What it talks to:**
 * - Uses `createSchemaEnvelopeV1` (import `createSchemaEnvelopeV1`) from `../schemaEnvelope`.
 * - Uses `PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME` (import `PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME`) from `./profileMemoryGraphContracts`.
 * - Uses local constants/helpers within this module.
 *
 * @param claims - Semantic-duplicate active claims.
 * @param winner - Canonical winner claim.
 * @param recordedAt - Deterministic repair timestamp.
 * @returns Winner claim with merged bounded lineage.
 */
function mergeSemanticDuplicateWinner(
  claims: readonly ProfileMemoryGraphClaimRecord[],
  winner: ProfileMemoryGraphClaimRecord,
  recordedAt: string
): ProfileMemoryGraphClaimRecord {
  return createSchemaEnvelopeV1(
    PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
    {
      ...winner.payload,
      stableRefId: winner.payload.stableRefId,
      sensitive: claims.some((claim) => claim.payload.sensitive),
      sourceTaskId: winner.payload.sourceTaskId,
      derivedFromObservationIds: mergeSortedStrings(
        claims.flatMap((claim) => claim.payload.derivedFromObservationIds)
      ),
      projectionSourceIds: [...winner.payload.projectionSourceIds],
      entityRefIds: [...winner.payload.entityRefIds]
    },
    safeIsoOrFallback(winner.createdAt, recordedAt)
  );
}

/**
 * Closes one duplicate active claim behind the canonical winner.
 *
 * **Why it exists:**
 * Repairing semantic duplicates by inactivating the extras keeps retained journal references valid
 * and preserves audit visibility without leaving multiple active winners on the same semantic claim.
 *
 * **What it talks to:**
 * - Uses `createSchemaEnvelopeV1` (import `createSchemaEnvelopeV1`) from `../schemaEnvelope`.
 * - Uses `PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME` (import `PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME`) from `./profileMemoryGraphContracts`.
 * - Uses local constants/helpers within this module.
 *
 * @param input - Duplicate claim, chosen winner, and deterministic repair timestamp.
 * @returns Closed duplicate claim record.
 */
function closeSemanticDuplicateClaim(input: {
  claim: ProfileMemoryGraphClaimRecord;
  winner: ProfileMemoryGraphClaimRecord;
  recordedAt: string;
}): ProfileMemoryGraphClaimRecord {
  const closureBoundary = maxIsoTimestamp([
    input.claim.payload.validFrom,
    input.claim.payload.assertedAt,
    input.winner.payload.validFrom,
    input.winner.payload.assertedAt,
    input.recordedAt
  ]);
  return createSchemaEnvelopeV1(
    PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
    {
      ...input.claim.payload,
      active: false,
      validTo: input.claim.payload.validTo ?? closureBoundary,
      endedAt: input.claim.payload.endedAt ?? closureBoundary,
      endedByClaimId: input.winner.payload.claimId
    },
    safeIsoOrFallback(input.claim.createdAt, input.recordedAt)
  );
}

/**
 * Compares two claims for canonical winner selection inside one semantic-duplicate group.
 *
 * **Why it exists:**
 * The repair path needs a stable freshness rule that prefers the strongest surviving record without
 * depending on insertion order.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param left - Left claim candidate.
 * @param right - Right claim candidate.
 * @returns Positive when `left` should replace `right` as the canonical winner.
 */
function compareClaimFreshness(
  left: ProfileMemoryGraphClaimRecord,
  right: ProfileMemoryGraphClaimRecord
): number {
  const leftPriority = claimFreshnessPriority(left);
  const rightPriority = claimFreshnessPriority(right);
  if (leftPriority !== rightPriority) {
    return leftPriority.localeCompare(rightPriority);
  }
  if (left.createdAt !== right.createdAt) {
    return left.createdAt.localeCompare(right.createdAt);
  }
  if (left.hash !== right.hash) {
    return left.hash.localeCompare(right.hash);
  }
  return left.payload.claimId.localeCompare(right.payload.claimId);
}

/**
 * Builds one comparable freshness priority string for a graph claim.
 *
 * **Why it exists:**
 * Winner selection should prefer the newest claim semantics first and only fall back to envelope
 * metadata when those semantic timestamps tie.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param claim - Claim candidate.
 * @returns Comparable freshness priority string.
 */
function claimFreshnessPriority(claim: ProfileMemoryGraphClaimRecord): string {
  return maxIsoTimestamp([
    claim.payload.validFrom,
    claim.payload.assertedAt
  ]);
}

/**
 * Returns the latest usable ISO timestamp from one bounded candidate list.
 *
 * **Why it exists:**
 * Duplicate repair needs closure and freshness boundaries that never move backward because one
 * malformed record omitted a timestamp or carried an invalid date.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param values - Candidate timestamp values.
 * @returns Latest valid ISO timestamp, or the empty string when none are usable.
 */
function maxIsoTimestamp(values: readonly (string | null | undefined)[]): string {
  let winner = "";
  for (const value of values) {
    const normalized = safeIsoOrFallback(value, "");
    if (normalized.length > 0 && normalized.localeCompare(winner) > 0) {
      winner = normalized;
    }
  }
  return winner;
}

/**
 * Merges one bounded string collection into a sorted unique list.
 *
 * **Why it exists:**
 * Winner repair needs to preserve lineage and projection refs from duplicate claims without keeping
 * repeated ids or relying on insertion order.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param values - Candidate string values from one duplicate group.
 * @returns Sorted unique string list.
 */
function mergeSortedStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

/**
 * Orders graph claims deterministically after duplicate repair.
 *
 * **Why it exists:**
 * Normalization should emit one stable persisted order regardless of which duplicate group changed.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
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
 * Compares two claim records for structural equality without relying on object identity.
 *
 * **Why it exists:**
 * The repair path only wants to report change when the canonical record contents actually differ.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param left - Left claim record.
 * @param right - Right claim record.
 * @returns `true` when the two claim records are equivalent.
 */
function graphClaimRecordsEqual(
  left: ProfileMemoryGraphClaimRecord,
  right: ProfileMemoryGraphClaimRecord
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Coerces one timestamp candidate to ISO format with a caller-supplied fallback.
 *
 * **Why it exists:**
 * Normalization repair must tolerate malformed retained timestamps without throwing or inventing a
 * non-deterministic boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Unknown timestamp candidate.
 * @param fallback - Fallback ISO timestamp.
 * @returns Valid ISO timestamp string or the fallback when invalid.
 */
function safeIsoOrFallback(value: unknown, fallback: string): string {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(Date.parse(value)).toISOString()
    : fallback;
}
