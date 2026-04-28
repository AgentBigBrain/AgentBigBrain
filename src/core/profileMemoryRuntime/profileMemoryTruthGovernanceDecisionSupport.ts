/**
 * @fileoverview Shared canonical decision builders for deterministic profile-memory truth governance.
 */

import type {
  CreateProfileEpisodeRecordInput,
  ProfileEpisodeResolutionInput
} from "./profileMemoryEpisodeContracts";
import {
  assertProfileMemoryAdjacentDomainAccessAllowed,
  assertProfileMemoryGovernanceDecisionAllowed
} from "./profileMemoryFamilyRegistry";
import type {
  ProfileMemoryEvidenceClass,
  ProfileMemoryGovernanceDecision,
  ProfileMemoryGovernanceFamily
} from "./profileMemoryTruthGovernanceContracts";
import {
  ALLOWED_ASSISTANT_INFERENCE_EPISODE_SOURCES,
  ALLOWED_EXPLICIT_EPISODE_SOURCES,
  isDocumentOrMediaDerivedProfileMemorySource
} from "./profileMemoryTruthGovernanceSources";

/**
 * Builds one stable governance decision object from the closed contract values.
 *
 * @param source - Runtime source that produced the candidate.
 * @param family - Canonical family bucket for the candidate.
 * @param evidenceClass - Closed evidence class.
 * @param action - Governance action to apply.
 * @param reason - Deterministic machine-checkable reason.
 * @returns Stable governance decision.
 */
export function buildCanonicalGovernanceDecision(
  source: string,
  family: ProfileMemoryGovernanceFamily,
  evidenceClass: ProfileMemoryEvidenceClass,
  action: ProfileMemoryGovernanceDecision["action"],
  reason: ProfileMemoryGovernanceDecision["reason"]
): ProfileMemoryGovernanceDecision {
  const decision: ProfileMemoryGovernanceDecision = {
    family,
    evidenceClass,
    action,
    reason
  };
  assertProfileMemoryGovernanceDecisionAllowed(decision);
  assertProfileMemoryAdjacentDomainAccessAllowed(source, decision);
  return decision;
}

/**
 * Classifies one episode candidate into a closed evidence class and governance action.
 *
 * @param candidate - Episode candidate headed toward canonical mutation.
 * @returns Machine-checkable governance decision.
 */
export function buildEpisodeGovernanceDecision(
  candidate: CreateProfileEpisodeRecordInput
): ProfileMemoryGovernanceDecision {
  const normalizedSource = candidate.source.trim().toLowerCase();
  const buildDecision = (
    family: ProfileMemoryGovernanceFamily,
    evidenceClass: ProfileMemoryEvidenceClass,
    action: ProfileMemoryGovernanceDecision["action"],
    reason: ProfileMemoryGovernanceDecision["reason"]
  ): ProfileMemoryGovernanceDecision =>
    buildCanonicalGovernanceDecision(normalizedSource, family, evidenceClass, action, reason);
  if (normalizedSource.startsWith("conversation.")) {
    return buildDecision("episode.candidate", "validated_structured_candidate", "quarantine", "unsupported_source");
  }
  if (normalizedSource.startsWith("profile_state_reconciliation.")) {
    return buildDecision("episode.candidate", "reconciliation_or_projection", "quarantine", "unsupported_source");
  }
  if (isDocumentOrMediaDerivedProfileMemorySource(normalizedSource)) {
    return buildDecision("episode.candidate", "assistant_inference", "quarantine", "unsupported_source");
  }
  if (candidate.sourceKind === "explicit_user_statement") {
    if (ALLOWED_EXPLICIT_EPISODE_SOURCES.has(normalizedSource)) {
      return buildDecision("episode.candidate", "user_explicit_episode", "allow_episode_support", "explicit_user_episode");
    }
    return buildDecision("episode.candidate", "user_explicit_episode", "quarantine", "unsupported_source");
  }
  if (candidate.sourceKind === "assistant_inference") {
    if (ALLOWED_ASSISTANT_INFERENCE_EPISODE_SOURCES.has(normalizedSource)) {
      return buildDecision("episode.candidate", "assistant_inference", "allow_episode_support", "assistant_inference_episode");
    }
    return buildDecision("episode.candidate", "assistant_inference", "quarantine", "unsupported_source");
  }
  return buildDecision("episode.candidate", "assistant_inference", "quarantine", "unsupported_source");
}

/**
 * Classifies one episode-resolution candidate into a deterministic end-state governance action.
 *
 * @param candidate - Episode-resolution candidate headed toward canonical mutation.
 * @returns Machine-checkable governance decision.
 */
export function buildEpisodeResolutionGovernanceDecision(
  candidate: ProfileEpisodeResolutionInput
): ProfileMemoryGovernanceDecision {
  const normalizedSource = candidate.source.trim().toLowerCase();
  const buildDecision = (
    family: ProfileMemoryGovernanceFamily,
    evidenceClass: ProfileMemoryEvidenceClass,
    action: ProfileMemoryGovernanceDecision["action"],
    reason: ProfileMemoryGovernanceDecision["reason"]
  ): ProfileMemoryGovernanceDecision =>
    buildCanonicalGovernanceDecision(normalizedSource, family, evidenceClass, action, reason);
  if (normalizedSource === "user_input_pattern.episode_resolution_inferred") {
    return buildDecision("episode.resolution", "assistant_inference", "allow_end_state", "episode_resolution_end_state");
  }
  if (normalizedSource.startsWith("conversation.")) {
    return buildDecision("episode.resolution", "validated_structured_candidate", "quarantine", "unsupported_source");
  }
  if (normalizedSource.startsWith("profile_state_reconciliation.")) {
    return buildDecision("episode.resolution", "reconciliation_or_projection", "quarantine", "unsupported_source");
  }
  if (normalizedSource.startsWith("user_input_pattern.")) {
    return buildDecision("episode.resolution", "user_explicit_fact", "quarantine", "unsupported_source");
  }
  return buildDecision("episode.resolution", "assistant_inference", "quarantine", "unsupported_source");
}
