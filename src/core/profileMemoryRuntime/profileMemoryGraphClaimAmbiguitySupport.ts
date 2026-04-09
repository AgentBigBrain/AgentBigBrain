/**
 * @fileoverview Non-authoritative active-claim ambiguity helpers for additive graph state.
 */

import type { ProfileMemoryGraphClaimRecord } from "./profileMemoryGraphContracts";
import { isProfileMemoryGraphClaimCurrentSurfaceEligible } from "./profileMemoryGraphClaimSurfaceEligibilitySupport";
import { getProfileMemoryFamilyRegistryEntry } from "./profileMemoryFamilyRegistry";
import { inferGovernanceFamilyForNormalizedKey } from "./profileMemoryGovernanceFamilyInference";
import type {
  ProfileMemoryDisplacementPolicy,
  ProfileMemoryInventoryPolicy
} from "./profileMemoryTruthGovernanceContracts";

/**
 * Collects active same-key different-value claim ids that remain ambiguous because no
 * authoritative replacement family survives the group.
 *
 * **Why it exists:**
 * Phase 3 graph normalization should keep malformed preserve-prior ambiguity visible in canonical
 * claim state and the derived conflict surface, but that ambiguity should not mint synthetic
 * replay or synthetic observation-lineage proof. This helper centralizes the bounded guard used by
 * those synthetic repair lanes.
 *
 * **What it talks to:**
 * - Uses `inferGovernanceFamilyForNormalizedKey` (import
 *   `inferGovernanceFamilyForNormalizedKey`) from
 *   `./profileMemoryGovernanceFamilyInference`.
 * - Uses `getProfileMemoryFamilyRegistryEntry` (import
 *   `getProfileMemoryFamilyRegistryEntry`) from `./profileMemoryFamilyRegistry`.
 *
 * @param claims - Canonical graph claims under ambiguity evaluation.
 * @returns Claim ids that belong to non-authoritative single-current ambiguity groups.
 */
export function collectProfileMemoryGraphNonAuthoritativeAmbiguousClaimIds(
  claims: readonly ProfileMemoryGraphClaimRecord[]
): ReadonlySet<string> {
  const groups = new Map<string, ProfileMemoryGraphClaimRecord[]>();
  for (const claim of claims) {
    if (!hasUsableActiveClaimSemantics(claim)) {
      continue;
    }
    const bucket = groups.get(claim.payload.normalizedKey) ?? [];
    bucket.push(claim);
    groups.set(claim.payload.normalizedKey, bucket);
  }

  const ambiguousClaimIds = new Set<string>();
  for (const group of groups.values()) {
    if (group.length <= 1) {
      continue;
    }
    if (new Set(group.map((claim) => claim.payload.normalizedValue)).size <= 1) {
      continue;
    }
    if (group.some((claim) => isAuthoritativeConflictFamily(claim))) {
      continue;
    }
    if (!group.some((claim) => hasSingleCurrentWinnerInventoryPolicy(claim))) {
      continue;
    }
    for (const claim of group) {
      ambiguousClaimIds.add(claim.payload.claimId);
    }
  }

  return ambiguousClaimIds;
}

/**
 * Checks whether one claim still belongs on the active ambiguity lane.
 *
 * @param claim - Canonical graph claim candidate.
 * @returns `true` when the claim is active, non-redacted, and still eligible for the bounded
 *   current or canonical end-state claim surface.
 */
function hasUsableActiveClaimSemantics(claim: ProfileMemoryGraphClaimRecord): boolean {
  return (
    claim.payload.active &&
    claim.payload.redactionState !== "redacted" &&
    isProfileMemoryGraphClaimCurrentSurfaceEligible(claim)
  );
}

/**
 * Evaluates whether one claim belongs to an authoritative replacement family.
 *
 * @param claim - Active graph claim candidate.
 * @returns `true` when authoritative repair should pick a deterministic winner.
 */
function isAuthoritativeConflictFamily(claim: ProfileMemoryGraphClaimRecord): boolean {
  const displacementPolicy = resolveClaimDisplacementPolicy(claim);
  return (
    displacementPolicy === "replace_authoritative_successor" ||
    displacementPolicy === "resolution_only"
  );
}

/**
 * Evaluates whether one claim belongs to a family that expects a single current winner.
 *
 * @param claim - Active graph claim candidate.
 * @returns `true` when same-key ambiguity represents malformed singular-current state.
 */
function hasSingleCurrentWinnerInventoryPolicy(claim: ProfileMemoryGraphClaimRecord): boolean {
  return resolveClaimInventoryPolicy(claim) === "single_current_winner";
}

/**
 * Resolves the inferred-family displacement policy for one claim.
 *
 * @param claim - Active graph claim candidate.
 * @returns Conflict-relevant displacement policy.
 */
function resolveClaimDisplacementPolicy(
  claim: ProfileMemoryGraphClaimRecord
): ProfileMemoryDisplacementPolicy {
  return resolveClaimRegistryEntry(claim).displacementPolicy;
}

/**
 * Resolves the inferred-family inventory policy for one claim.
 *
 * @param claim - Active graph claim candidate.
 * @returns Conflict-relevant inventory policy.
 */
function resolveClaimInventoryPolicy(
  claim: ProfileMemoryGraphClaimRecord
): ProfileMemoryInventoryPolicy {
  return resolveClaimRegistryEntry(claim).inventoryPolicy;
}

/**
 * Resolves the inferred-family registry entry for one claim.
 *
 * @param claim - Active graph claim candidate.
 * @returns Inferred family registry entry.
 */
function resolveClaimRegistryEntry(claim: ProfileMemoryGraphClaimRecord) {
  const family = inferGovernanceFamilyForNormalizedKey(
    claim.payload.normalizedKey,
    claim.payload.normalizedValue ?? ""
  );
  return getProfileMemoryFamilyRegistryEntry(family);
}
