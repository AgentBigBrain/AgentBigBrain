/**
 * @fileoverview Current-surface eligibility helpers for additive graph claim records.
 */

import type {
  ProfileMemoryGraphClaimRecord,
  ProfileMemoryGraphSourceTier
} from "./profileMemoryGraphContracts";
import { getProfileMemoryFamilyRegistryEntry } from "./profileMemoryFamilyRegistry";
import { inferGovernanceFamilyForNormalizedKey } from "./profileMemoryGovernanceFamilyInference";
import type { ProfileMemoryGovernanceFamily } from "./profileMemoryTruthGovernanceContracts";

/**
 * Evaluates whether one retained graph claim belongs on the bounded current-claim surface.
 *
 * **Why it exists:**
 * Live fact-to-graph mutation only creates claim records for governed current-state or canonical
 * end-state decisions. Older or malformed retained graph state can still carry active claims for
 * support-only or auxiliary families, and those records should remain canonical-only for audit
 * instead of receiving synthetic replay/lineage repair or surfacing in the derived current-claim
 * read model.
 *
 * **What it talks to:**
 * - Uses `inferGovernanceFamilyForNormalizedKey` (import
 *   `inferGovernanceFamilyForNormalizedKey`) from
 *   `./profileMemoryGovernanceFamilyInference`.
 * - Uses `getProfileMemoryFamilyRegistryEntry` (import
 *   `getProfileMemoryFamilyRegistryEntry`) from `./profileMemoryFamilyRegistry`.
 *
 * @param claim - Canonical graph claim under evaluation.
 * @returns `true` when the retained payload family matches the governed family implied by the
 *   claim semantic identity.
 */
export function isProfileMemoryGraphClaimFamilyAlignedWithGovernedSemantics(
  claim: ProfileMemoryGraphClaimRecord
): boolean {
  const inferredFamily = resolveProfileMemoryGraphClaimGovernedFamily(claim);
  if (inferredFamily === null) {
    return false;
  }
  return claim.payload.family.trim() === inferredFamily;
}

/**
 * Evaluates whether one retained graph claim belongs on the bounded current-claim surface.
 *
 * **Why it exists:**
 * Live fact-to-graph mutation only creates claim records for governed current-state or canonical
 * end-state decisions. Older or malformed retained graph state can still carry active claims for
 * support-only or auxiliary families, and those records should remain canonical-only for audit
 * instead of receiving synthetic replay/lineage repair or surfacing in the derived current-claim
 * read model.
 *
 * **What it talks to:**
 * - Uses `inferGovernanceFamilyForNormalizedKey` (import
 *   `inferGovernanceFamilyForNormalizedKey`) from
 *   `./profileMemoryGovernanceFamilyInference`.
 * - Uses `getProfileMemoryFamilyRegistryEntry` (import
 *   `getProfileMemoryFamilyRegistryEntry`) from `./profileMemoryFamilyRegistry`.
 *
 * @param claim - Canonical graph claim under evaluation.
 * @returns `true` when the inferred family is eligible for current-state or canonical end-state
 *   claim projection and the retained payload family still matches that governed semantic family.
 */
export function isProfileMemoryGraphClaimCurrentSurfaceEligible(
  claim: ProfileMemoryGraphClaimRecord
): boolean {
  const inferredFamily = resolveProfileMemoryGraphClaimGovernedFamily(claim);
  if (inferredFamily === null) {
    return false;
  }
  if (claim.payload.family.trim() !== inferredFamily) {
    return false;
  }
  if (
    !isProfileMemoryGraphClaimSourceTierEligibleForGovernedFamily(
      inferredFamily,
      claim.payload.sourceTier
    )
  ) {
    return false;
  }
  const entry = getProfileMemoryFamilyRegistryEntry(inferredFamily);
  return entry.currentStateEligible || entry.endStatePolicy === "canonical_end_state";
}

/**
 * Resolves the code-owned governed family for one retained graph claim when the semantic identity
 * is still usable.
 *
 * **Why it exists:**
 * The bounded current-surface and repair lanes need one shared family inference step so malformed
 * blank-semantic claims fail closed before family- or source-authority checks run.
 *
 * @param claim - Canonical graph claim under evaluation.
 * @returns Inferred governed family, or `null` when semantic identity is unusable.
 */
function resolveProfileMemoryGraphClaimGovernedFamily(
  claim: ProfileMemoryGraphClaimRecord
): ProfileMemoryGovernanceFamily | null {
  const payloadFamily = claim.payload.family.trim();
  const normalizedKey = claim.payload.normalizedKey.trim();
  const normalizedValue =
    typeof claim.payload.normalizedValue === "string"
      ? claim.payload.normalizedValue.trim()
      : "";
  if (payloadFamily.length === 0 || normalizedKey.length === 0 || normalizedValue.length === 0) {
    return null;
  }
  return inferGovernanceFamilyForNormalizedKey(normalizedKey, normalizedValue);
}

/**
 * Evaluates whether the retained graph claim source tier can still author bounded current or
 * canonical end-state truth for one governed family.
 *
 * **Why it exists:**
 * Retained graph claims only persist the bounded `sourceTier`, not the original raw source string.
 * This helper therefore fail-closes only the non-explicit source tiers whose live truth-governance
 * outcome is family-deterministic, so malformed retained inference or projection claims cannot
 * survive as current truth after load normalization.
 *
 * @param family - Code-owned governed family for the retained claim semantics.
 * @param sourceTier - Persisted graph source tier.
 * @returns `true` when that retained source tier may still author bounded graph truth.
 */
function isProfileMemoryGraphClaimSourceTierEligibleForGovernedFamily(
  family: ProfileMemoryGovernanceFamily,
  sourceTier: ProfileMemoryGraphSourceTier
): boolean {
  switch (family) {
    case "identity.preferred_name":
      return (
        sourceTier === "explicit_user_statement" ||
        sourceTier === "validated_structured_candidate"
      );
    case "followup.resolution":
      return (
        sourceTier === "explicit_user_statement" ||
        sourceTier === "reconciliation_or_projection" ||
        sourceTier === "assistant_inference"
      );
    default:
      return sourceTier === "explicit_user_statement";
  }
}
