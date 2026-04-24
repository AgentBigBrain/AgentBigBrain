/** @fileoverview Shared support constants for the profile-memory family registry. */
import type {
  ProfileMemoryAdjacentDomainPolicy,
  ProfileMemoryCompatibilityProjectionPolicy,
  ProfileMemoryContactGovernanceFamily
} from "./profileMemoryTruthGovernanceContracts";

export const DEFAULT_ADJACENT_DOMAIN_POLICY: ProfileMemoryAdjacentDomainPolicy = {
  structured_conversation: "disallowed",
  reconciliation_projection: "disallowed",
  assistant_inference: "disallowed",
  semantic_memory: "auxiliary_only",
  governance_history: "auxiliary_only",
  audit_trail: "auxiliary_only",
  session_continuity: "auxiliary_only",
  stage6_86: "auxiliary_only"
};

export const PROFILE_MEMORY_CONTACT_COMPATIBILITY_PROJECTION_TABLE: Readonly<
  Record<ProfileMemoryContactGovernanceFamily, ProfileMemoryCompatibilityProjectionPolicy>
> = {
  "contact.name": "corroboration_hidden",
  "contact.relationship": "ordinary_current_truth",
  "contact.work_association": "ordinary_current_truth",
  "contact.organization_association": "ordinary_current_truth",
  "contact.location_association": "ordinary_current_truth",
  "contact.school_association": "support_only_hidden",
  "contact.context": "support_only_visible",
  "contact.entity_hint": "corroboration_hidden"
} as const;

/**
 * Builds one full adjacent-domain policy by overlaying family-specific access on top of the
 * fail-closed defaults.
 *
 * @param overrides - Family-specific adjacent-domain access overrides.
 * @returns One complete adjacent-domain policy record.
 */
export function withAdjacentDomainOverrides(
  overrides: Partial<ProfileMemoryAdjacentDomainPolicy>
): ProfileMemoryAdjacentDomainPolicy {
  return {
    ...DEFAULT_ADJACENT_DOMAIN_POLICY,
    ...overrides
  };
}
