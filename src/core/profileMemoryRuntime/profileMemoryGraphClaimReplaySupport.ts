/**
 * @fileoverview Synthetic replay-marker helpers for legacy active graph claims.
 */

import { sha256HexFromCanonicalJson } from "../normalizers/canonicalizationRules";
import type {
  ProfileMemoryGraphClaimRecord,
  ProfileMemoryGraphCompactionStateV1,
  ProfileMemoryMutationJournalStateV1
} from "./profileMemoryGraphContracts";
import { collectProfileMemoryGraphNonAuthoritativeAmbiguousClaimIds } from "./profileMemoryGraphClaimAmbiguitySupport";
import { isProfileMemoryGraphClaimCurrentSurfaceEligible } from "./profileMemoryGraphClaimSurfaceEligibilitySupport";

/**
 * Collects active claim ids that still need one synthetic replay marker because the loaded graph
 * state comes from a legacy uncompacted envelope with missing replay coverage.
 *
 * @param input - Canonical graph claims plus retained mutation-journal state.
 * @returns Sorted active claim ids still missing replay coverage.
 */
export function collectProfileMemoryGraphReplayBackfillClaimIds(input: {
  claims: readonly ProfileMemoryGraphClaimRecord[];
  compaction: ProfileMemoryGraphCompactionStateV1;
  mutationJournal: ProfileMemoryMutationJournalStateV1;
}): string[] {
  if (input.compaction.snapshotWatermark > 0) {
    return [];
  }
  const ambiguousClaimIds = collectProfileMemoryGraphNonAuthoritativeAmbiguousClaimIds(
    input.claims
  );
  const journalClaimIds = new Set(input.mutationJournal.entries.flatMap((entry) => entry.claimIds));
  return input.claims
    .filter(
      (claim) =>
        claim.payload.active &&
        claim.payload.redactionState !== "redacted" &&
        hasUsableClaimSemanticIdentity(claim) &&
        isProfileMemoryGraphClaimCurrentSurfaceEligible(claim) &&
        !ambiguousClaimIds.has(claim.payload.claimId) &&
        !journalClaimIds.has(claim.payload.claimId)
    )
    .map((claim) => claim.payload.claimId)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Builds one deterministic source fingerprint for synthetic replay-marker backfill on active
 * graph claims already present in persisted state.
 *
 * @param claimIds - Active graph claim ids missing retained replay coverage.
 * @returns Deterministic synthetic replay-marker fingerprint.
 */
export function buildProfileMemoryGraphClaimReplayBackfillFingerprint(
  claimIds: readonly string[]
): string {
  return `graph_claim_replay_backfill_${sha256HexFromCanonicalJson([...claimIds].sort()).slice(0, 24)}`;
}

/**
 * Evaluates whether one active claim carries a usable semantic identity for replay repair.
 *
 * @param claim - Active graph claim candidate.
 * @returns `true` when the claim has non-blank family or normalized-key semantics plus one
 * non-blank current value.
 */
function hasUsableClaimSemanticIdentity(claim: ProfileMemoryGraphClaimRecord): boolean {
  return (
    claim.payload.family.trim().length > 0 &&
    claim.payload.normalizedKey.trim().length > 0 &&
    typeof claim.payload.normalizedValue === "string" &&
    claim.payload.normalizedValue.trim().length > 0
  );
}
