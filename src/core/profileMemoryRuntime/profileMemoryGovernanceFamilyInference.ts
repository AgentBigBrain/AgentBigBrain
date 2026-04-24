/**
 * @fileoverview Closed governance-family inference for fail-closed source-authority decisions.
 */

import type { ProfileMemoryGovernanceFamily } from "./profileMemoryTruthGovernanceContracts";

/**
 * Infers the closed governance family for a normalized fact key.
 *
 * This is used for fail-closed source-authority decisions where the source is known to be
 * unsupported for the target family and we still want a machine-checkable family label instead of
 * collapsing the record into a generic catch-all bucket.
 *
 * @param normalizedKey - Lowercased fact key under evaluation.
 * @param rawValue - Original candidate value, used for the follow-up end-state seam.
 * @returns Closed governance family label.
 */
export function inferGovernanceFamilyForNormalizedKey(
  normalizedKey: string,
  rawValue: string
): ProfileMemoryGovernanceFamily {
  if (normalizedKey === "identity.preferred_name") {
    return "identity.preferred_name";
  }
  if (normalizedKey === "employment.current") {
    return "employment.current";
  }
  if (normalizedKey === "residence.current") {
    return "residence.current";
  }
  if (normalizedKey.startsWith("followup.") && rawValue.trim().toLowerCase() === "resolved") {
    return "followup.resolution";
  }
  if (/^contact\.[^.]+\.name$/.test(normalizedKey)) {
    return "contact.name";
  }
  if (/^contact\.[^.]+\.relationship$/.test(normalizedKey)) {
    return "contact.relationship";
  }
  if (/^contact\.[^.]+\.work_association$/.test(normalizedKey)) {
    return "contact.work_association";
  }
  if (/^contact\.[^.]+\.organization_association$/.test(normalizedKey)) {
    return "contact.organization_association";
  }
  if (
    /^contact\.[^.]+\.(location_association|primary_location_association|secondary_location_association)$/.test(
      normalizedKey
    )
  ) {
    return "contact.location_association";
  }
  if (/^contact\.[^.]+\.school_association$/.test(normalizedKey)) {
    return "contact.school_association";
  }
  if (/^contact\.[^.]+\.context\./.test(normalizedKey)) {
    return "contact.context";
  }
  return "generic.profile_fact";
}
