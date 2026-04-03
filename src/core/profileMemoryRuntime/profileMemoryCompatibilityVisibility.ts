/**
 * @fileoverview Shared fail-closed compatibility visibility rules for flat fact projection and
 * bounded readable/query surfaces.
 */

import type { ProfileFactRecord, ProfileFactUpsertInput } from "../profileMemory";

type CompatibilityFactLike = Pick<ProfileFactRecord, "key" | "source"> | Pick<ProfileFactUpsertInput, "key" | "source">;

const HISTORICAL_OR_SEVERED_CONTACT_SUPPORT_SOURCES = new Set([
  "user_input_pattern.work_with_contact_historical",
  "user_input_pattern.work_association_historical",
  "user_input_pattern.work_with_contact_severed",
  "user_input_pattern.direct_contact_relationship_historical",
  "user_input_pattern.direct_contact_relationship_severed"
]);

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

  if (
    normalizedSource === "user_input_pattern.work_at_historical" ||
    normalizedSource === "user_input_pattern.residence_historical"
  ) {
    return false;
  }

  if (HISTORICAL_OR_SEVERED_CONTACT_SUPPORT_SOURCES.has(normalizedSource)) {
    return /^contact\.[^.]+\.name$/.test(normalizedKey);
  }

  if (normalizedSource === "user_input_pattern.school_association") {
    return false;
  }
  if (
    normalizedSource === "user_input_pattern.contact_context" &&
    !/^contact\.[^.]+\.context\.[^.]+$/.test(normalizedKey)
  ) {
    return false;
  }
  if (normalizedSource === "user_input_pattern.contact_entity_hint") {
    return false;
  }

  return true;
}
