/**
 * @fileoverview Closed truth-governance contracts for profile-memory candidate normalization.
 */

import type { ProfileFactUpsertInput } from "../profileMemory";
import type {
  CreateProfileEpisodeRecordInput,
  ProfileEpisodeResolutionInput
} from "./profileMemoryEpisodeContracts";

export type ProfileMemoryEvidenceClass =
  | "user_explicit_fact"
  | "validated_structured_candidate"
  | "user_explicit_episode"
  | "user_hint_or_context"
  | "assistant_inference"
  | "reconciliation_or_projection";

export type ProfileMemoryGovernanceFamily =
  | "identity.preferred_name"
  | "employment.current"
  | "residence.current"
  | "followup.resolution"
  | "contact.name"
  | "contact.relationship"
  | "contact.work_association"
  | "contact.school_association"
  | "contact.context"
  | "contact.entity_hint"
  | "generic.profile_fact"
  | "episode.candidate"
  | "episode.resolution";

export type ProfileMemoryGovernanceAction =
  | "allow_current_state"
  | "allow_episode_support"
  | "support_only_legacy"
  | "allow_end_state"
  | "quarantine";

export type ProfileMemoryGovernanceReason =
  | "explicit_user_fact"
  | "validated_semantic_candidate"
  | "explicit_user_episode"
  | "assistant_inference_episode"
  | "contact_context_is_support_only"
  | "contact_entity_hint_requires_corroboration"
  | "historical_work_linkage_support_only"
  | "severed_work_linkage_support_only"
  | "historical_contact_relationship_support_only"
  | "severed_contact_relationship_support_only"
  | "historical_school_association_support_only"
  | "historical_employment_support_only"
  | "historical_residence_support_only"
  | "followup_resolution_end_state"
  | "episode_resolution_end_state"
  | "legacy_fact_family_default"
  | "unsupported_source";

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
