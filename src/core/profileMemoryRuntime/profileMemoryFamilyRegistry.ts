/** @fileoverview Code-owned family registry for profile-memory governance policy. */
import type { ProfileMemoryAdjacentDomain, ProfileMemoryEvidenceClass, ProfileMemoryFamilyRegistryEntry, ProfileMemoryMinimumSensitivityFloor, ProfileMemoryGovernanceDecision, ProfileMemoryGovernanceFamily } from "./profileMemoryTruthGovernanceContracts";
import {
  PROFILE_MEMORY_CONTACT_COMPATIBILITY_PROJECTION_TABLE,
  withAdjacentDomainOverrides
} from "./profileMemoryFamilyRegistrySupport";
import { isSensitiveKey } from "./profileMemoryNormalization";

export { PROFILE_MEMORY_CONTACT_COMPATIBILITY_PROJECTION_TABLE } from "./profileMemoryFamilyRegistrySupport";

export const PROFILE_MEMORY_FAMILY_REGISTRY_VERSION = 1 as const;

export const PROFILE_MEMORY_FAMILY_REGISTRY: Readonly<
  Record<ProfileMemoryGovernanceFamily, ProfileMemoryFamilyRegistryEntry>
> = {
  "identity.preferred_name": {
    family: "identity.preferred_name",
    cardinality: "singular",
    currentStateEligible: true,
    currentStateAdmissionPolicy: "validated_or_explicit_live_source_only",
    episodeSupportEligible: false,
    endStatePolicy: "none",
    displacementPolicy: "replace_authoritative_successor",
    supportOnlyLegacyBehavior: "disallowed",
    corroborationMode: "not_required",
    answerModeFallback: "report_ambiguous_contested",
    minimumSensitivityFloor: "inherit",
    inventoryPolicy: "single_current_winner",
    sourceAuthorityMode: "exact_source_only",
    compatibilityProjection: "ordinary_current_truth",
    adjacentDomainPolicy: withAdjacentDomainOverrides({
      structured_conversation: "truth_authoritative"
    })
  },
  "employment.current": {
    family: "employment.current",
    cardinality: "singular",
    currentStateEligible: true,
    currentStateAdmissionPolicy: "explicit_live_source_only",
    episodeSupportEligible: false,
    endStatePolicy: "support_only_transition",
    displacementPolicy: "preserve_prior_on_conflict",
    supportOnlyLegacyBehavior: "support_only_hidden_on_compatibility_surfaces",
    corroborationMode: "not_required",
    answerModeFallback: "report_ambiguous_contested",
    minimumSensitivityFloor: "inherit",
    inventoryPolicy: "single_current_winner",
    sourceAuthorityMode: "exact_source_only",
    compatibilityProjection: "ordinary_current_truth",
    adjacentDomainPolicy: withAdjacentDomainOverrides({})
  },
  "residence.current": {
    family: "residence.current",
    cardinality: "singular",
    currentStateEligible: true,
    currentStateAdmissionPolicy: "explicit_live_source_only",
    episodeSupportEligible: false,
    endStatePolicy: "support_only_transition",
    displacementPolicy: "preserve_prior_on_conflict",
    supportOnlyLegacyBehavior: "support_only_hidden_on_compatibility_surfaces",
    corroborationMode: "not_required",
    answerModeFallback: "report_ambiguous_contested",
    minimumSensitivityFloor: "force_sensitive",
    inventoryPolicy: "single_current_winner",
    sourceAuthorityMode: "exact_source_only",
    compatibilityProjection: "ordinary_current_truth",
    adjacentDomainPolicy: withAdjacentDomainOverrides({})
  },
  "followup.resolution": {
    family: "followup.resolution",
    cardinality: "singular",
    currentStateEligible: false,
    currentStateAdmissionPolicy: "not_allowed",
    episodeSupportEligible: false,
    endStatePolicy: "canonical_end_state",
    displacementPolicy: "resolution_only",
    supportOnlyLegacyBehavior: "disallowed",
    corroborationMode: "not_required",
    answerModeFallback: "report_insufficient_evidence",
    minimumSensitivityFloor: "inherit",
    inventoryPolicy: "single_current_winner",
    sourceAuthorityMode: "exact_source_only",
    compatibilityProjection: "end_state_only",
    adjacentDomainPolicy: withAdjacentDomainOverrides({
      reconciliation_projection: "truth_authoritative",
      assistant_inference: "truth_authoritative"
    })
  },
  "contact.name": {
    family: "contact.name",
    cardinality: "singular",
    currentStateEligible: true,
    currentStateAdmissionPolicy: "explicit_live_source_only",
    episodeSupportEligible: false,
    endStatePolicy: "none",
    displacementPolicy: "preserve_prior_on_conflict",
    supportOnlyLegacyBehavior: "support_only_name_only_on_compatibility_surfaces",
    corroborationMode: "required_before_current_state",
    answerModeFallback: "report_insufficient_evidence",
    minimumSensitivityFloor: "inherit",
    inventoryPolicy: "single_current_winner",
    sourceAuthorityMode: "exact_source_only",
    compatibilityProjection: PROFILE_MEMORY_CONTACT_COMPATIBILITY_PROJECTION_TABLE["contact.name"],
    adjacentDomainPolicy: withAdjacentDomainOverrides({})
  },
  "contact.relationship": {
    family: "contact.relationship",
    cardinality: "singular",
    currentStateEligible: true,
    currentStateAdmissionPolicy: "explicit_live_source_only",
    episodeSupportEligible: false,
    endStatePolicy: "support_only_transition",
    displacementPolicy: "preserve_prior_on_conflict",
    supportOnlyLegacyBehavior: "support_only_hidden_on_compatibility_surfaces",
    corroborationMode: "not_required",
    answerModeFallback: "report_ambiguous_contested",
    minimumSensitivityFloor: "inherit",
    inventoryPolicy: "single_current_winner",
    sourceAuthorityMode: "exact_source_only",
    compatibilityProjection: PROFILE_MEMORY_CONTACT_COMPATIBILITY_PROJECTION_TABLE["contact.relationship"],
    adjacentDomainPolicy: withAdjacentDomainOverrides({})
  },
  "contact.work_association": {
    family: "contact.work_association",
    cardinality: "singular",
    currentStateEligible: true,
    currentStateAdmissionPolicy: "explicit_live_source_only",
    episodeSupportEligible: false,
    endStatePolicy: "support_only_transition",
    displacementPolicy: "preserve_prior_on_conflict",
    supportOnlyLegacyBehavior: "support_only_hidden_on_compatibility_surfaces",
    corroborationMode: "not_required",
    answerModeFallback: "report_ambiguous_contested",
    minimumSensitivityFloor: "inherit",
    inventoryPolicy: "single_current_winner",
    sourceAuthorityMode: "exact_source_only",
    compatibilityProjection: PROFILE_MEMORY_CONTACT_COMPATIBILITY_PROJECTION_TABLE["contact.work_association"],
    adjacentDomainPolicy: withAdjacentDomainOverrides({})
  },
  "contact.school_association": {
    family: "contact.school_association",
    cardinality: "singular",
    currentStateEligible: false,
    currentStateAdmissionPolicy: "not_allowed",
    episodeSupportEligible: false,
    endStatePolicy: "support_only_transition",
    displacementPolicy: "preserve_prior_on_conflict",
    supportOnlyLegacyBehavior: "support_only_hidden_on_compatibility_surfaces",
    corroborationMode: "not_required",
    answerModeFallback: "report_supporting_history",
    minimumSensitivityFloor: "inherit",
    inventoryPolicy: "single_current_winner",
    sourceAuthorityMode: "exact_source_only",
    compatibilityProjection: PROFILE_MEMORY_CONTACT_COMPATIBILITY_PROJECTION_TABLE["contact.school_association"],
    adjacentDomainPolicy: withAdjacentDomainOverrides({})
  },
  "contact.context": {
    family: "contact.context",
    cardinality: "multi",
    currentStateEligible: false,
    currentStateAdmissionPolicy: "not_allowed",
    episodeSupportEligible: false,
    endStatePolicy: "none",
    displacementPolicy: "append_multi_value",
    supportOnlyLegacyBehavior: "support_only_visible_on_compatibility_surfaces",
    corroborationMode: "not_required",
    answerModeFallback: "report_supporting_history",
    minimumSensitivityFloor: "inherit",
    inventoryPolicy: "bounded_multi_value",
    sourceAuthorityMode: "exact_source_only",
    compatibilityProjection: PROFILE_MEMORY_CONTACT_COMPATIBILITY_PROJECTION_TABLE["contact.context"],
    adjacentDomainPolicy: withAdjacentDomainOverrides({})
  },
  "contact.entity_hint": {
    family: "contact.entity_hint",
    cardinality: "auxiliary",
    currentStateEligible: false,
    currentStateAdmissionPolicy: "not_allowed",
    episodeSupportEligible: false,
    endStatePolicy: "none",
    displacementPolicy: "not_applicable",
    supportOnlyLegacyBehavior: "support_only_hidden_on_compatibility_surfaces",
    corroborationMode: "required_before_current_state",
    answerModeFallback: "report_insufficient_evidence",
    minimumSensitivityFloor: "inherit",
    inventoryPolicy: "auxiliary_hidden",
    sourceAuthorityMode: "exact_source_only",
    compatibilityProjection: PROFILE_MEMORY_CONTACT_COMPATIBILITY_PROJECTION_TABLE["contact.entity_hint"],
    adjacentDomainPolicy: withAdjacentDomainOverrides({})
  },
  "generic.profile_fact": {
    family: "generic.profile_fact",
    cardinality: "singular",
    currentStateEligible: true,
    currentStateAdmissionPolicy: "validated_or_explicit_live_source_only",
    episodeSupportEligible: false,
    endStatePolicy: "none",
    displacementPolicy: "preserve_prior_on_conflict",
    supportOnlyLegacyBehavior: "disallowed",
    corroborationMode: "not_required",
    answerModeFallback: "report_ambiguous_contested",
    minimumSensitivityFloor: "force_sensitive_for_sensitive_keys",
    inventoryPolicy: "single_current_winner",
    sourceAuthorityMode: "exact_source_only",
    compatibilityProjection: "ordinary_current_truth",
    adjacentDomainPolicy: withAdjacentDomainOverrides({})
  },
  "episode.candidate": {
    family: "episode.candidate",
    cardinality: "episode_only",
    currentStateEligible: false,
    currentStateAdmissionPolicy: "not_allowed",
    episodeSupportEligible: true,
    endStatePolicy: "none",
    displacementPolicy: "append_multi_value",
    supportOnlyLegacyBehavior: "disallowed",
    corroborationMode: "not_required",
    answerModeFallback: "report_supporting_history",
    minimumSensitivityFloor: "inherit",
    inventoryPolicy: "episode_timeline",
    sourceAuthorityMode: "exact_source_only",
    compatibilityProjection: "episode_only",
    adjacentDomainPolicy: withAdjacentDomainOverrides({
      assistant_inference: "truth_authoritative"
    })
  },
  "episode.resolution": {
    family: "episode.resolution",
    cardinality: "episode_only",
    currentStateEligible: false,
    currentStateAdmissionPolicy: "not_allowed",
    episodeSupportEligible: false,
    endStatePolicy: "canonical_end_state",
    displacementPolicy: "resolution_only",
    supportOnlyLegacyBehavior: "disallowed",
    corroborationMode: "not_required",
    answerModeFallback: "report_insufficient_evidence",
    minimumSensitivityFloor: "inherit",
    inventoryPolicy: "episode_timeline",
    sourceAuthorityMode: "exact_source_only",
    compatibilityProjection: "end_state_only",
    adjacentDomainPolicy: withAdjacentDomainOverrides({
      assistant_inference: "truth_authoritative"
    })
  }
} as const;

/** Returns the code-owned registry entry for one canonical profile-memory governance family. */
export function getProfileMemoryFamilyRegistryEntry(
  family: ProfileMemoryGovernanceFamily
): ProfileMemoryFamilyRegistryEntry {
  return PROFILE_MEMORY_FAMILY_REGISTRY[family];
}

/** Infers one adjacent runtime domain from the bounded governed source/evidence pair. */
export function inferProfileMemoryAdjacentDomain(
  source: string,
  evidenceClass: ProfileMemoryEvidenceClass
): ProfileMemoryAdjacentDomain | null {
  const normalizedSource = source.trim().toLowerCase();

  if (normalizedSource.startsWith("conversation.")) {
    return "structured_conversation";
  }
  if (normalizedSource.startsWith("profile_state_reconciliation.")) {
    return "reconciliation_projection";
  }
  if (normalizedSource.startsWith("semantic_memory.")) {
    return "semantic_memory";
  }
  if (normalizedSource.startsWith("governance_memory.")) {
    return "governance_history";
  }
  if (
    normalizedSource.startsWith("audit.") ||
    normalizedSource.startsWith("memory_access_audit.")
  ) {
    return "audit_trail";
  }
  if (
    normalizedSource.startsWith("session.") ||
    normalizedSource.startsWith("conversation_session.")
  ) {
    return "session_continuity";
  }
  if (normalizedSource.startsWith("stage6_86.")) {
    return "stage6_86";
  }
  if (evidenceClass === "assistant_inference") {
    return "assistant_inference";
  }

  return null;
}

/** Fails closed when one governance decision violates the code-owned family registry. */
export function assertProfileMemoryGovernanceDecisionAllowed(
  decision: ProfileMemoryGovernanceDecision
): void {
  const familyEntry = getProfileMemoryFamilyRegistryEntry(decision.family);
  const isLiveExplicitCurrentStateDecision =
    decision.evidenceClass === "user_explicit_fact" &&
    (
      decision.reason === "explicit_user_fact" ||
      decision.reason === "legacy_fact_family_default"
    );

  if (decision.action === "allow_current_state" && !familyEntry.currentStateEligible) {
    throw new Error(
      `Family ${decision.family} is not current-state eligible in the profile-memory family registry.`
    );
  }
  if (
    decision.action === "allow_episode_support" &&
    !familyEntry.episodeSupportEligible
  ) {
    throw new Error(
      `Family ${decision.family} is not episode-support eligible in the profile-memory family registry.`
    );
  }
  if (
    decision.action === "support_only_legacy" &&
    familyEntry.supportOnlyLegacyBehavior === "disallowed"
  ) {
    throw new Error(
      `Family ${decision.family} does not allow support-only legacy behavior in the profile-memory family registry.`
    );
  }
  if (
    decision.action === "allow_end_state" &&
    familyEntry.endStatePolicy === "none"
  ) {
    throw new Error(
      `Family ${decision.family} does not allow end-state decisions in the profile-memory family registry.`
    );
  }
  if (decision.action === "allow_current_state") {
    if (decision.reason === "memory_review_correction_override") {
      return;
    }
    if (
      familyEntry.currentStateAdmissionPolicy === "explicit_live_source_only" &&
      !isLiveExplicitCurrentStateDecision
    ) {
      throw new Error(
        `Family ${decision.family} only allows current-state promotion from live explicit-user sources in the profile-memory family registry.`
      );
    }
    if (
      familyEntry.currentStateAdmissionPolicy ===
        "validated_or_explicit_live_source_only" &&
      !(
        isLiveExplicitCurrentStateDecision ||
        (
          decision.evidenceClass === "validated_structured_candidate" &&
          decision.reason === "validated_semantic_candidate"
        )
      )
    ) {
      throw new Error(
        `Family ${decision.family} only allows current-state promotion from live explicit or validated semantic sources in the profile-memory family registry.`
      );
    }
  }
}

/** Fails closed when one adjacent runtime domain attempts an unauthorized governance action. */
export function assertProfileMemoryAdjacentDomainAccessAllowed(
  source: string,
  decision: ProfileMemoryGovernanceDecision
): void {
  if (decision.action === "quarantine") {
    return;
  }

  const adjacentDomain = inferProfileMemoryAdjacentDomain(
    source,
    decision.evidenceClass
  );
  if (!adjacentDomain) {
    return;
  }

  const familyEntry = getProfileMemoryFamilyRegistryEntry(decision.family);
  const access = familyEntry.adjacentDomainPolicy[adjacentDomain];

  if (decision.action === "support_only_legacy") {
    if (access === "truth_authoritative" || access === "support_only") {
      return;
    }
    throw new Error(
      `Family ${decision.family} does not allow ${adjacentDomain} to create support-only legacy evidence in the profile-memory family registry.`
    );
  }

  if (access !== "truth_authoritative") {
    throw new Error(
      `Family ${decision.family} does not allow ${adjacentDomain} to create authoritative truth decisions in the profile-memory family registry.`
    );
  }
}

/** Returns the effective minimum sensitivity floor for one canonical profile-memory family. */
export function getProfileMemoryMinimumSensitivityFloor(
  family: ProfileMemoryGovernanceFamily
): ProfileMemoryMinimumSensitivityFloor {
  return getProfileMemoryFamilyRegistryEntry(family).minimumSensitivityFloor;
}

/** Applies the family-owned minimum sensitivity floor to one fact-like candidate or projection. */
export function applyProfileMemoryMinimumSensitivityFloor(
  family: ProfileMemoryGovernanceFamily,
  sensitive: boolean,
  key?: string
): boolean {
  const minimumSensitivityFloor = getProfileMemoryMinimumSensitivityFloor(family);
  if (minimumSensitivityFloor === "force_sensitive") {
    return true;
  }
  if (
    minimumSensitivityFloor === "force_sensitive_for_sensitive_keys" &&
    typeof key === "string" &&
    isSensitiveKey(key)
  ) {
    return true;
  }
  return sensitive;
}
