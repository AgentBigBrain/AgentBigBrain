/**
 * @fileoverview Shared fail-closed compatibility visibility rules for flat fact projection and
 * bounded readable/query surfaces.
 */

import type { ProfileFactRecord, ProfileFactUpsertInput } from "../profileMemory";
import { getProfileMemoryFamilyRegistryEntry } from "./profileMemoryFamilyRegistry";
import { inferGovernanceFamilyForNormalizedKey } from "./profileMemoryGovernanceFamilyInference";
import type { ProfileMemoryGovernanceFamily } from "./profileMemoryTruthGovernanceContracts";

type CompatibilityFactLike = Pick<ProfileFactRecord, "key" | "source" | "value"> | Pick<ProfileFactUpsertInput, "key" | "source" | "value">;

const HISTORICAL_OR_SEVERED_CONTACT_SUPPORT_SOURCES = new Set([
  "user_input_pattern.work_with_contact_historical",
  "user_input_pattern.work_association_historical",
  "user_input_pattern.work_with_contact_severed",
  "user_input_pattern.direct_contact_relationship_historical",
  "user_input_pattern.direct_contact_relationship_severed"
]);

/**
 * Infers the registry family that owns compatibility visibility for one fact-like record.
 *
 * Some compatibility rules are source-scoped rather than key-scoped, so this helper maps those
 * exact legacy sources onto the registry family that governs their compatibility posture.
 *
 * @param normalizedKey - Lowercased fact key under evaluation.
 * @param normalizedSource - Lowercased fact source under evaluation.
 * @param rawValue - Fact value used for bounded family inference where needed.
 * @returns Registry family that owns compatibility visibility for the fact.
 */
function inferCompatibilityPolicyFamily(
  normalizedKey: string,
  normalizedSource: string,
  rawValue: string
): ProfileMemoryGovernanceFamily {
  if (normalizedSource === "user_input_pattern.contact_entity_hint") {
    return "contact.entity_hint";
  }
  if (normalizedSource === "user_input_pattern.contact_context") {
    return "contact.context";
  }
  return inferGovernanceFamilyForNormalizedKey(normalizedKey, rawValue);
}

/**
 * Applies one support-only compatibility projection policy to the current fact key.
 *
 * @param family - Registry family that owns the support-only visibility decision.
 * @param normalizedKey - Lowercased fact key under evaluation.
 * @returns `true` when the support-only fact may remain visible on compatibility surfaces.
 */
function isSupportOnlyCompatibilityVisible(
  family: ProfileMemoryGovernanceFamily,
  normalizedKey: string
): boolean {
  const familyEntry = getProfileMemoryFamilyRegistryEntry(family);
  if (
    familyEntry.supportOnlyLegacyBehavior ===
    "support_only_name_only_on_compatibility_surfaces"
  ) {
    return /^contact\.[^.]+\.name$/.test(normalizedKey);
  }
  switch (familyEntry.compatibilityProjection) {
    case "support_only_visible":
      return /^contact\.[^.]+\.context\.[^.]+$/.test(normalizedKey);
    case "support_only_hidden":
    case "corroboration_hidden":
      return false;
    case "end_state_only":
      return normalizedKey.startsWith("followup.");
    case "ordinary_current_truth":
    case "support_only_name_only":
    case "episode_only":
      return false;
  }
}

/**
 * Applies one ordinary current-truth compatibility projection policy to the current fact family.
 *
 * @param family - Registry family that owns the ordinary visibility decision.
 * @returns `true` when the fact may remain visible on compatibility surfaces outside support-only
 * legacy handling.
 */
function isOrdinaryCompatibilityVisible(
  family: ProfileMemoryGovernanceFamily
): boolean {
  const familyEntry = getProfileMemoryFamilyRegistryEntry(family);
  switch (familyEntry.compatibilityProjection) {
    case "ordinary_current_truth":
    case "end_state_only":
      return true;
    case "corroboration_hidden":
      return family === "contact.name";
    case "support_only_hidden":
    case "support_only_visible":
    case "support_only_name_only":
    case "episode_only":
      return false;
  }
}

/**
 * Evaluates whether one fact remains safe to expose on flat compatibility surfaces.
 *
 * Compatibility-unsafe support-only historical or severed facts must not appear as ordinary
 * current truth on flat fact reads or planner/query projections until graph-backed history can
 * carry them explicitly.
 *
 * @param fact - Fact-like record under evaluation.
 * @returns `true` when the fact is safe to keep on flat/read/query compatibility surfaces.
 */
export function isCompatibilityVisibleFactLike(fact: CompatibilityFactLike): boolean {
  const normalizedKey = fact.key.trim().toLowerCase();
  const normalizedSource = fact.source.trim().toLowerCase();
  const policyFamily = inferCompatibilityPolicyFamily(
    normalizedKey,
    normalizedSource,
    fact.value
  );

  if (
    normalizedSource === "user_input_pattern.work_at_historical" ||
    normalizedSource === "user_input_pattern.residence_historical"
  ) {
    return isSupportOnlyCompatibilityVisible(policyFamily, normalizedKey);
  }

  if (HISTORICAL_OR_SEVERED_CONTACT_SUPPORT_SOURCES.has(normalizedSource)) {
    return isSupportOnlyCompatibilityVisible("contact.name", normalizedKey);
  }

  if (normalizedSource === "user_input_pattern.school_association") {
    return isSupportOnlyCompatibilityVisible(policyFamily, normalizedKey);
  }
  if (
    normalizedSource === "user_input_pattern.contact_context" ||
    normalizedSource === "user_input_pattern.contact_entity_hint"
  ) {
    return isSupportOnlyCompatibilityVisible(policyFamily, normalizedKey);
  }

  return isOrdinaryCompatibilityVisible(policyFamily);
}
