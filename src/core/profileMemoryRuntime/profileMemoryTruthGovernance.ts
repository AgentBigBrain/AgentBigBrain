/**
 * @fileoverview Deterministic truth-governance classification for profile-memory candidates.
 */

import type { ProfileFactUpsertInput } from "../profileMemory";
import type {
  CreateProfileEpisodeRecordInput,
  ProfileEpisodeResolutionInput
} from "./profileMemoryEpisodeContracts";
import {
  type GovernedProfileEpisodeCandidate,
  type GovernedProfileEpisodeResolution,
  type GovernedProfileFactCandidate,
  type ProfileMemoryEvidenceClass,
  type ProfileMemoryGovernanceDecision,
  type ProfileMemoryGovernanceFamily,
  type ProfileMemoryTruthGovernanceResult
} from "./profileMemoryTruthGovernanceContracts";
import {
  getProfileMemoryFamilyRegistryEntry
} from "./profileMemoryFamilyRegistry";
import { applyProfileMemoryMinimumSensitivityFloorToFactCandidate } from "./profileMemoryFactSensitivity";
import { inferGovernanceFamilyForNormalizedKey } from "./profileMemoryGovernanceFamilyInference";
import {
  buildCanonicalGovernanceDecision,
  buildEpisodeGovernanceDecision,
  buildEpisodeResolutionGovernanceDecision
} from "./profileMemoryTruthGovernanceDecisionSupport";
import {
  ALLOWED_EXPLICIT_CONTACT_CONTEXT_SOURCES,
  ALLOWED_EXPLICIT_CURRENT_CONTACT_GENERIC_ASSOCIATION_SOURCES,
  ALLOWED_EXPLICIT_CONTACT_NAME_SOURCES,
  ALLOWED_EXPLICIT_CURRENT_CONTACT_RELATIONSHIP_SOURCES,
  ALLOWED_EXPLICIT_CURRENT_CONTACT_WORK_ASSOCIATION_SOURCES,
  MEMORY_REVIEW_FACT_CORRECTION_SOURCE
} from "./profileMemoryTruthGovernanceSources";
/**
 * Classifies one fact candidate into a closed evidence class, family, action, and reason.
 *
 * @param candidate - Fact candidate headed toward canonical mutation.
 * @returns Machine-checkable governance decision.
 */
function buildFactGovernanceDecision(candidate: ProfileFactUpsertInput): ProfileMemoryGovernanceDecision {
  const normalizedKey = candidate.key.trim().toLowerCase();
  const normalizedSource = candidate.source.trim().toLowerCase();
  const buildDecision = (
    family: ProfileMemoryGovernanceFamily,
    evidenceClass: ProfileMemoryEvidenceClass,
    action: ProfileMemoryGovernanceDecision["action"],
    reason: ProfileMemoryGovernanceDecision["reason"]
  ): ProfileMemoryGovernanceDecision =>
    buildCanonicalGovernanceDecision(normalizedSource, family, evidenceClass, action, reason);
  const isValidatedStructuredSource = normalizedSource.startsWith("conversation.");
  const isExplicitUserSource = normalizedSource.startsWith("user_input_pattern.");
  const isProjectionSource = normalizedSource.startsWith("profile_state_reconciliation.");
  const isAllowedStructuredIdentitySource =
    normalizedSource === "conversation.identity_interpretation";
  const isAllowedExplicitIdentitySource =
    normalizedSource === "user_input_pattern.name_phrase";
  const isAllowedExplicitEmploymentSource =
    normalizedSource === "user_input_pattern.work_at" ||
    normalizedSource === "user_input_pattern.job_is";
  const isAllowedExplicitResidenceSource =
    normalizedSource === "user_input_pattern.residence";
  const isAllowedExplicitGenericFactSource =
    normalizedSource === "user_input_pattern.my_is"
    || ALLOWED_EXPLICIT_CURRENT_CONTACT_GENERIC_ASSOCIATION_SOURCES.has(normalizedSource);
  const isAllowedExplicitContactNameSource =
    ALLOWED_EXPLICIT_CONTACT_NAME_SOURCES.has(normalizedSource);
  const isAllowedExplicitCurrentContactRelationshipSource =
    ALLOWED_EXPLICIT_CURRENT_CONTACT_RELATIONSHIP_SOURCES.has(normalizedSource);
  const isAllowedExplicitCurrentContactWorkAssociationSource =
    ALLOWED_EXPLICIT_CURRENT_CONTACT_WORK_ASSOCIATION_SOURCES.has(normalizedSource);
  const isAllowedExplicitSchoolAssociationSource =
    normalizedSource === "user_input_pattern.school_association";
  const isAllowedExplicitFollowupSource =
    normalizedSource === "user_input_pattern.followup_resolved";
  const isAllowedInferredFollowupSource =
    normalizedSource === "user_input_pattern.followup_resolved_inferred";
  const isAllowedProjectionFollowupSource =
    normalizedSource === "profile_state_reconciliation.followup_resolved";
  const isContactEntityHintSource =
    normalizedSource === "user_input_pattern.contact_entity_hint";
  const inferredFamily = inferGovernanceFamilyForNormalizedKey(normalizedKey, candidate.value);

  if (normalizedSource === MEMORY_REVIEW_FACT_CORRECTION_SOURCE) {
    const familyEntry = getProfileMemoryFamilyRegistryEntry(inferredFamily);
    if (familyEntry.currentStateEligible) {
      return buildDecision(
        inferredFamily,
        "user_explicit_fact",
        "allow_current_state",
        "memory_review_correction_override"
      );
    }
    return buildDecision(
      inferredFamily,
      "user_explicit_fact",
      "quarantine",
      "unsupported_source"
    );
  }

  if (isContactEntityHintSource) {
    if (/^contact\.[^.]+\.name$/.test(normalizedKey)) {
      return buildDecision(
        "contact.entity_hint",
        "user_hint_or_context",
        "support_only_legacy",
        "contact_entity_hint_requires_corroboration"
      );
    }
    return buildDecision(
      inferredFamily,
      "user_hint_or_context",
      "quarantine",
      "unsupported_source"
    );
  }
  if (normalizedKey === "identity.preferred_name") {
    if (isAllowedStructuredIdentitySource) {
      return buildDecision("identity.preferred_name", "validated_structured_candidate", "allow_current_state", "validated_semantic_candidate");
    }
    if (isAllowedExplicitIdentitySource) {
      return buildDecision("identity.preferred_name", "user_explicit_fact", "allow_current_state", "explicit_user_fact");
    }
    if (isProjectionSource) {
      return buildDecision("identity.preferred_name", "reconciliation_or_projection", "quarantine", "unsupported_source");
    }
    if (isExplicitUserSource) {
      return buildDecision("identity.preferred_name", "user_explicit_fact", "quarantine", "unsupported_source");
    }
    if (isValidatedStructuredSource) {
      return buildDecision("identity.preferred_name", "validated_structured_candidate", "quarantine", "unsupported_source");
    }
    return buildDecision("identity.preferred_name", "assistant_inference", "quarantine", "unsupported_source");
  }
  if (normalizedKey === "employment.current") {
    if (normalizedSource === "user_input_pattern.work_at_historical") {
      return buildDecision("employment.current", "user_explicit_fact", "support_only_legacy", "historical_employment_support_only");
    }
    if (isValidatedStructuredSource) {
      return buildDecision("employment.current", "validated_structured_candidate", "quarantine", "unsupported_source");
    }
    if (isProjectionSource) {
      return buildDecision("employment.current", "reconciliation_or_projection", "quarantine", "unsupported_source");
    }
    if (isAllowedExplicitEmploymentSource) {
      return buildDecision("employment.current", "user_explicit_fact", "allow_current_state", "explicit_user_fact");
    }
    if (isExplicitUserSource) {
      return buildDecision("employment.current", "user_explicit_fact", "quarantine", "unsupported_source");
    }
    return buildDecision("employment.current", "assistant_inference", "quarantine", "unsupported_source");
  }
  if (normalizedKey === "residence.current") {
    if (normalizedSource === "user_input_pattern.residence_historical") {
      return buildDecision("residence.current", "user_explicit_fact", "support_only_legacy", "historical_residence_support_only");
    }
    if (isValidatedStructuredSource) {
      return buildDecision("residence.current", "validated_structured_candidate", "quarantine", "unsupported_source");
    }
    if (isProjectionSource) {
      return buildDecision("residence.current", "reconciliation_or_projection", "quarantine", "unsupported_source");
    }
    if (isAllowedExplicitResidenceSource) {
      return buildDecision("residence.current", "user_explicit_fact", "allow_current_state", "explicit_user_fact");
    }
    if (isExplicitUserSource) {
      return buildDecision("residence.current", "user_explicit_fact", "quarantine", "unsupported_source");
    }
    return buildDecision("residence.current", "assistant_inference", "quarantine", "unsupported_source");
  }
  if (normalizedKey.startsWith("followup.") && candidate.value.trim().toLowerCase() === "resolved") {
    if (isAllowedProjectionFollowupSource) {
      return buildDecision("followup.resolution", "reconciliation_or_projection", "allow_end_state", "followup_resolution_end_state");
    }
    if (isAllowedInferredFollowupSource) {
      return buildDecision("followup.resolution", "assistant_inference", "allow_end_state", "followup_resolution_end_state");
    }
    if (isAllowedExplicitFollowupSource) {
      return buildDecision("followup.resolution", "user_explicit_fact", "allow_end_state", "followup_resolution_end_state");
    }
    if (isValidatedStructuredSource) {
      return buildDecision("followup.resolution", "validated_structured_candidate", "quarantine", "unsupported_source");
    }
    if (isProjectionSource) {
      return buildDecision("followup.resolution", "reconciliation_or_projection", "quarantine", "unsupported_source");
    }
    if (isExplicitUserSource) {
      return buildDecision("followup.resolution", "user_explicit_fact", "quarantine", "unsupported_source");
    }
    return buildDecision("followup.resolution", "assistant_inference", "quarantine", "unsupported_source");
  }
  if (/^contact\.[^.]+\.name$/.test(normalizedKey)) {
    if (isValidatedStructuredSource) {
      return buildDecision("contact.name", "validated_structured_candidate", "quarantine", "unsupported_source");
    }
    if (isProjectionSource) {
      return buildDecision("contact.name", "reconciliation_or_projection", "quarantine", "unsupported_source");
    }
    if (isAllowedExplicitContactNameSource) {
      return buildDecision("contact.name", "user_explicit_fact", "allow_current_state", "explicit_user_fact");
    }
    if (isExplicitUserSource) {
      return buildDecision("contact.name", "user_explicit_fact", "quarantine", "unsupported_source");
    }
    return buildDecision("contact.name", "assistant_inference", "quarantine", "unsupported_source");
  }
  if (/^contact\.[^.]+\.relationship$/.test(normalizedKey)) {
    if (normalizedSource === "user_input_pattern.direct_contact_relationship_severed") {
      return buildDecision("contact.relationship", "user_explicit_fact", "support_only_legacy", "severed_contact_relationship_support_only");
    }
    if (normalizedSource === "user_input_pattern.direct_contact_relationship_historical") {
      return buildDecision("contact.relationship", "user_explicit_fact", "support_only_legacy", "historical_contact_relationship_support_only");
    }
    if (
      normalizedSource === "user_input_pattern.work_with_contact_severed"
    ) {
      return buildDecision("contact.relationship", "user_explicit_fact", "support_only_legacy", "severed_work_linkage_support_only");
    }
    if (
      normalizedSource === "user_input_pattern.work_with_contact_historical" ||
      normalizedSource === "user_input_pattern.work_association_historical"
    ) {
      return buildDecision("contact.relationship", "user_explicit_fact", "support_only_legacy", "historical_work_linkage_support_only");
    }
    if (isValidatedStructuredSource) {
      return buildDecision("contact.relationship", "validated_structured_candidate", "quarantine", "unsupported_source");
    }
    if (isProjectionSource) {
      return buildDecision("contact.relationship", "reconciliation_or_projection", "quarantine", "unsupported_source");
    }
    if (isAllowedExplicitCurrentContactRelationshipSource) {
      return buildDecision("contact.relationship", "user_explicit_fact", "allow_current_state", "explicit_user_fact");
    }
    if (isExplicitUserSource) {
      return buildDecision("contact.relationship", "user_explicit_fact", "quarantine", "unsupported_source");
    }
    return buildDecision("contact.relationship", "assistant_inference", "quarantine", "unsupported_source");
  }
  if (/^contact\.[^.]+\.work_association$/.test(normalizedKey)) {
    if (normalizedSource === "user_input_pattern.direct_contact_relationship_severed") {
      return buildDecision("contact.work_association", "user_explicit_fact", "support_only_legacy", "severed_contact_relationship_support_only");
    }
    if (normalizedSource === "user_input_pattern.direct_contact_relationship_historical") {
      return buildDecision("contact.work_association", "user_explicit_fact", "support_only_legacy", "historical_contact_relationship_support_only");
    }
    if (
      normalizedSource === "user_input_pattern.work_with_contact_severed"
    ) {
      return buildDecision("contact.work_association", "user_explicit_fact", "support_only_legacy", "severed_work_linkage_support_only");
    }
    if (
      normalizedSource === "user_input_pattern.work_with_contact_historical" ||
      normalizedSource === "user_input_pattern.work_association_historical"
    ) {
      return buildDecision("contact.work_association", "user_explicit_fact", "support_only_legacy", "historical_work_linkage_support_only");
    }
    if (isValidatedStructuredSource) {
      return buildDecision("contact.work_association", "validated_structured_candidate", "quarantine", "unsupported_source");
    }
    if (isProjectionSource) {
      return buildDecision("contact.work_association", "reconciliation_or_projection", "quarantine", "unsupported_source");
    }
    if (isAllowedExplicitCurrentContactWorkAssociationSource) {
      return buildDecision("contact.work_association", "user_explicit_fact", "allow_current_state", "explicit_user_fact");
    }
    if (isExplicitUserSource) {
      return buildDecision("contact.work_association", "user_explicit_fact", "quarantine", "unsupported_source");
    }
    return buildDecision("contact.work_association", "assistant_inference", "quarantine", "unsupported_source");
  }
  if (/^contact\.[^.]+\.school_association$/.test(normalizedKey)) {
    if (isValidatedStructuredSource) {
      return buildDecision("contact.school_association", "validated_structured_candidate", "quarantine", "unsupported_source");
    }
    if (isProjectionSource) {
      return buildDecision("contact.school_association", "reconciliation_or_projection", "quarantine", "unsupported_source");
    }
    if (isAllowedExplicitSchoolAssociationSource) {
      return buildDecision("contact.school_association", "user_explicit_fact", "support_only_legacy", "historical_school_association_support_only");
    }
    if (isExplicitUserSource) {
      return buildDecision("contact.school_association", "user_explicit_fact", "quarantine", "unsupported_source");
    }
    return buildDecision("contact.school_association", "assistant_inference", "quarantine", "unsupported_source");
  }
  if (/^contact\.[^.]+\.context\./.test(normalizedKey)) {
    if (isValidatedStructuredSource) {
      return buildDecision("contact.context", "validated_structured_candidate", "quarantine", "unsupported_source");
    }
    if (ALLOWED_EXPLICIT_CONTACT_CONTEXT_SOURCES.has(normalizedSource)) {
      return buildDecision("contact.context", "user_hint_or_context", "support_only_legacy", "contact_context_is_support_only");
    }
    if (isExplicitUserSource) {
      return buildDecision("contact.context", "user_hint_or_context", "quarantine", "unsupported_source");
    }
    if (isProjectionSource) {
      return buildDecision("contact.context", "reconciliation_or_projection", "quarantine", "unsupported_source");
    }
    return buildDecision("contact.context", "assistant_inference", "quarantine", "unsupported_source");
  }
  if (isAllowedExplicitGenericFactSource) {
    return buildDecision("generic.profile_fact", "user_explicit_fact", "allow_current_state", "legacy_fact_family_default");
  }
  if (isExplicitUserSource) {
    return buildDecision("generic.profile_fact", "user_explicit_fact", "quarantine", "unsupported_source");
  }
  if (isValidatedStructuredSource) {
    return buildDecision("generic.profile_fact", "validated_structured_candidate", "quarantine", "unsupported_source");
  }
  if (isProjectionSource) {
    return buildDecision("generic.profile_fact", "reconciliation_or_projection", "quarantine", "unsupported_source");
  }
  return buildDecision("generic.profile_fact", "assistant_inference", "quarantine", "unsupported_source");
}
/**
 * Normalizes current fact, episode, and episode-resolution candidates through one deterministic
 * governance layer before canonical mutation.
 *
 * This initial Phase 2 slice classifies current runtime candidates into closed evidence classes and
 * machine-checkable policy decisions without forcing early retrieval or persistence cutover.
 *
 * @param input - Candidate collections headed toward canonical mutation.
 * @returns Governance result partitioned by action and backed by closed reasons.
 */
export function governProfileMemoryCandidates(input: {
  factCandidates: readonly ProfileFactUpsertInput[];
  episodeCandidates: readonly CreateProfileEpisodeRecordInput[];
  episodeResolutionCandidates: readonly ProfileEpisodeResolutionInput[];
}): ProfileMemoryTruthGovernanceResult {
  const factDecisions = input.factCandidates.map((candidate): GovernedProfileFactCandidate => {
    const decision = buildFactGovernanceDecision(candidate);
    return {
      candidate: applyProfileMemoryMinimumSensitivityFloorToFactCandidate(
        candidate,
        decision.family
      ),
      decision
    };
  });
  const episodeDecisions = input.episodeCandidates.map((candidate): GovernedProfileEpisodeCandidate => ({
    candidate,
    decision: buildEpisodeGovernanceDecision(candidate)
  }));
  const episodeResolutionDecisions = input.episodeResolutionCandidates.map(
    (candidate): GovernedProfileEpisodeResolution => ({
      candidate,
      decision: buildEpisodeResolutionGovernanceDecision(candidate)
    })
  );

  return {
    allowedCurrentStateFactCandidates: factDecisions
      .filter((entry) => entry.decision.action === "allow_current_state" || entry.decision.action === "allow_end_state")
      .map((entry) => entry.candidate),
    allowedSupportOnlyFactCandidates: factDecisions
      .filter((entry) => entry.decision.action === "support_only_legacy")
      .map((entry) => entry.candidate),
    allowedEpisodeCandidates: episodeDecisions
      .filter((entry) => entry.decision.action === "allow_episode_support")
      .map((entry) => entry.candidate),
    allowedEpisodeResolutionCandidates: episodeResolutionDecisions
      .filter((entry) => entry.decision.action === "allow_end_state")
      .map((entry) => entry.candidate),
    quarantinedFactCandidates: factDecisions.filter((entry) => entry.decision.action === "quarantine"),
    quarantinedEpisodeCandidates: episodeDecisions.filter((entry) => entry.decision.action === "quarantine"),
    quarantinedEpisodeResolutionCandidates: episodeResolutionDecisions.filter(
      (entry) => entry.decision.action === "quarantine"
    ),
    factDecisions,
    episodeDecisions,
    episodeResolutionDecisions
  };
}
