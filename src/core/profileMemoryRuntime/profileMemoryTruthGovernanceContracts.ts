/**
 * @fileoverview Closed truth-governance contracts for profile-memory candidate normalization.
 */

import type { ProfileFactUpsertInput } from "../profileMemory";
import type {
  CreateProfileEpisodeRecordInput,
  ProfileEpisodeResolutionInput
} from "./profileMemoryEpisodeContracts";

export const PROFILE_MEMORY_EVIDENCE_CLASSES = [
  "user_explicit_fact",
  "validated_structured_candidate",
  "user_explicit_episode",
  "user_hint_or_context",
  "assistant_inference",
  "reconciliation_or_projection"
] as const;

export type ProfileMemoryEvidenceClass =
  typeof PROFILE_MEMORY_EVIDENCE_CLASSES[number];

export const PROFILE_MEMORY_GOVERNANCE_FAMILIES = [
  "identity.preferred_name",
  "employment.current",
  "residence.current",
  "followup.resolution",
  "contact.name",
  "contact.relationship",
  "contact.work_association",
  "contact.school_association",
  "contact.context",
  "contact.entity_hint",
  "generic.profile_fact",
  "episode.candidate",
  "episode.resolution"
] as const;

export type ProfileMemoryGovernanceFamily =
  typeof PROFILE_MEMORY_GOVERNANCE_FAMILIES[number];

export type ProfileMemoryContactGovernanceFamily = Extract<
  ProfileMemoryGovernanceFamily,
  `contact.${string}`
>;

export const PROFILE_MEMORY_GOVERNANCE_ACTIONS = [
  "allow_current_state",
  "allow_episode_support",
  "support_only_legacy",
  "allow_end_state",
  "quarantine"
] as const;

export type ProfileMemoryGovernanceAction =
  typeof PROFILE_MEMORY_GOVERNANCE_ACTIONS[number];

export const PROFILE_MEMORY_GOVERNANCE_REASONS = [
  "explicit_user_fact",
  "validated_semantic_candidate",
  "explicit_user_episode",
  "assistant_inference_episode",
  "contact_context_is_support_only",
  "contact_entity_hint_requires_corroboration",
  "historical_work_linkage_support_only",
  "severed_work_linkage_support_only",
  "historical_contact_relationship_support_only",
  "severed_contact_relationship_support_only",
  "historical_school_association_support_only",
  "historical_employment_support_only",
  "historical_residence_support_only",
  "followup_resolution_end_state",
  "episode_resolution_end_state",
  "memory_review_resolution",
  "memory_review_correction_override",
  "memory_review_forget_or_delete",
  "legacy_fact_family_default",
  "unsupported_source"
] as const;

export type ProfileMemoryGovernanceReason =
  typeof PROFILE_MEMORY_GOVERNANCE_REASONS[number];

export const PROFILE_MEMORY_GOVERNANCE_CARDINALITIES = [
  "singular",
  "multi",
  "episode_only",
  "auxiliary"
] as const;

export type ProfileMemoryGovernanceCardinality =
  typeof PROFILE_MEMORY_GOVERNANCE_CARDINALITIES[number];

export const PROFILE_MEMORY_CURRENT_STATE_ADMISSION_POLICIES = [
  "not_allowed",
  "explicit_live_source_only",
  "validated_or_explicit_live_source_only"
] as const;

export type ProfileMemoryCurrentStateAdmissionPolicy =
  typeof PROFILE_MEMORY_CURRENT_STATE_ADMISSION_POLICIES[number];

export const PROFILE_MEMORY_END_STATE_POLICIES = [
  "none",
  "support_only_transition",
  "canonical_end_state"
] as const;

export type ProfileMemoryEndStatePolicy =
  typeof PROFILE_MEMORY_END_STATE_POLICIES[number];

export const PROFILE_MEMORY_DISPLACEMENT_POLICIES = [
  "replace_authoritative_successor",
  "preserve_prior_on_conflict",
  "append_multi_value",
  "resolution_only",
  "not_applicable"
] as const;

export type ProfileMemoryDisplacementPolicy =
  typeof PROFILE_MEMORY_DISPLACEMENT_POLICIES[number];

export const PROFILE_MEMORY_SUPPORT_ONLY_BEHAVIORS = [
  "disallowed",
  "support_only_hidden_on_compatibility_surfaces",
  "support_only_visible_on_compatibility_surfaces",
  "support_only_name_only_on_compatibility_surfaces"
] as const;

export type ProfileMemorySupportOnlyLegacyBehavior =
  typeof PROFILE_MEMORY_SUPPORT_ONLY_BEHAVIORS[number];

export const PROFILE_MEMORY_CORROBORATION_MODES = [
  "not_required",
  "required_before_current_state",
  "required_before_any_visibility"
] as const;

export type ProfileMemoryCorroborationMode =
  typeof PROFILE_MEMORY_CORROBORATION_MODES[number];

export const PROFILE_MEMORY_ANSWER_MODE_FALLBACKS = [
  "report_current_state",
  "report_supporting_history",
  "report_ambiguous_contested",
  "report_insufficient_evidence"
] as const;

export type ProfileMemoryAnswerModeFallback =
  typeof PROFILE_MEMORY_ANSWER_MODE_FALLBACKS[number];

export const PROFILE_MEMORY_MINIMUM_SENSITIVITY_FLOORS = [
  "inherit",
  "force_sensitive",
  "force_sensitive_for_sensitive_keys"
] as const;

export type ProfileMemoryMinimumSensitivityFloor =
  typeof PROFILE_MEMORY_MINIMUM_SENSITIVITY_FLOORS[number];

export const PROFILE_MEMORY_INVENTORY_POLICIES = [
  "single_current_winner",
  "bounded_multi_value",
  "episode_timeline",
  "auxiliary_hidden"
] as const;

export type ProfileMemoryInventoryPolicy =
  typeof PROFILE_MEMORY_INVENTORY_POLICIES[number];

export const PROFILE_MEMORY_SOURCE_AUTHORITY_MODES = [
  "exact_source_only"
] as const;

export type ProfileMemorySourceAuthorityMode =
  typeof PROFILE_MEMORY_SOURCE_AUTHORITY_MODES[number];

export const PROFILE_MEMORY_ADJACENT_DOMAINS = [
  "structured_conversation",
  "reconciliation_projection",
  "assistant_inference",
  "semantic_memory",
  "governance_history",
  "audit_trail",
  "session_continuity",
  "stage6_86"
] as const;

export type ProfileMemoryAdjacentDomain =
  typeof PROFILE_MEMORY_ADJACENT_DOMAINS[number];

export const PROFILE_MEMORY_ADJACENT_DOMAIN_ACCESS_LEVELS = [
  "truth_authoritative",
  "support_only",
  "auxiliary_only",
  "disallowed"
] as const;

export type ProfileMemoryAdjacentDomainAccess =
  typeof PROFILE_MEMORY_ADJACENT_DOMAIN_ACCESS_LEVELS[number];

export const PROFILE_MEMORY_COMPATIBILITY_PROJECTION_POLICIES = [
  "ordinary_current_truth",
  "support_only_hidden",
  "support_only_visible",
  "support_only_name_only",
  "corroboration_hidden",
  "episode_only",
  "end_state_only"
] as const;

export type ProfileMemoryCompatibilityProjectionPolicy =
  typeof PROFILE_MEMORY_COMPATIBILITY_PROJECTION_POLICIES[number];

export type ProfileMemoryAdjacentDomainPolicy = Readonly<
  Record<ProfileMemoryAdjacentDomain, ProfileMemoryAdjacentDomainAccess>
>;

export interface ProfileMemoryFamilyRegistryEntry {
  family: ProfileMemoryGovernanceFamily;
  cardinality: ProfileMemoryGovernanceCardinality;
  currentStateEligible: boolean;
  currentStateAdmissionPolicy: ProfileMemoryCurrentStateAdmissionPolicy;
  episodeSupportEligible: boolean;
  endStatePolicy: ProfileMemoryEndStatePolicy;
  displacementPolicy: ProfileMemoryDisplacementPolicy;
  supportOnlyLegacyBehavior: ProfileMemorySupportOnlyLegacyBehavior;
  corroborationMode: ProfileMemoryCorroborationMode;
  answerModeFallback: ProfileMemoryAnswerModeFallback;
  minimumSensitivityFloor: ProfileMemoryMinimumSensitivityFloor;
  inventoryPolicy: ProfileMemoryInventoryPolicy;
  sourceAuthorityMode: ProfileMemorySourceAuthorityMode;
  compatibilityProjection: ProfileMemoryCompatibilityProjectionPolicy;
  adjacentDomainPolicy: ProfileMemoryAdjacentDomainPolicy;
}

export interface ProfileMemoryGovernanceDecision {
  evidenceClass: ProfileMemoryEvidenceClass;
  family: ProfileMemoryGovernanceFamily;
  action: ProfileMemoryGovernanceAction;
  reason: ProfileMemoryGovernanceReason;
}

export interface GovernedProfileFactCandidate {
  candidate: ProfileFactUpsertInput;
  decision: ProfileMemoryGovernanceDecision;
}

export interface GovernedProfileEpisodeCandidate {
  candidate: CreateProfileEpisodeRecordInput;
  decision: ProfileMemoryGovernanceDecision;
}

export interface GovernedProfileEpisodeResolution {
  candidate: ProfileEpisodeResolutionInput;
  decision: ProfileMemoryGovernanceDecision;
}

export interface ProfileMemoryTruthGovernanceResult {
  allowedCurrentStateFactCandidates: readonly ProfileFactUpsertInput[];
  allowedSupportOnlyFactCandidates: readonly ProfileFactUpsertInput[];
  allowedEpisodeCandidates: readonly CreateProfileEpisodeRecordInput[];
  allowedEpisodeResolutionCandidates: readonly ProfileEpisodeResolutionInput[];
  quarantinedFactCandidates: readonly GovernedProfileFactCandidate[];
  quarantinedEpisodeCandidates: readonly GovernedProfileEpisodeCandidate[];
  quarantinedEpisodeResolutionCandidates: readonly GovernedProfileEpisodeResolution[];
  factDecisions: readonly GovernedProfileFactCandidate[];
  episodeDecisions: readonly GovernedProfileEpisodeCandidate[];
  episodeResolutionDecisions: readonly GovernedProfileEpisodeResolution[];
}
