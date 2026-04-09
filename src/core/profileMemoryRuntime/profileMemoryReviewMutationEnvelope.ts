/**
 * @fileoverview Bounded explicit review-mutation envelope builders for remembered situations and facts.
 */

import type { ProfileFactRecord } from "../profileMemory";
import type { ProfileEpisodeRecord } from "./profileMemoryEpisodeContracts";
import type { ProfileMemoryMutationDecisionRecord } from "./profileMemoryDecisionRecordContracts";
import type { ProfileMemoryMutationEnvelope } from "./profileMemoryMutationEnvelopeContracts";
import { inferGovernanceFamilyForNormalizedKey } from "./profileMemoryGovernanceFamilyInference";
import {
  buildCandidateRef,
  buildNormalizedInputIdentity,
  buildRollbackHandle
} from "./profileMemoryMutationEnvelopeSupport";
import type { ProfileMemoryGovernanceReason } from "./profileMemoryTruthGovernanceContracts";
import { getProfileMemoryFamilyRegistryEntry } from "./profileMemoryFamilyRegistry";

export interface BuildProfileMemoryReviewMutationEnvelopeInput {
  episodeId: string;
  sourceTaskId: string;
  sourceText: string;
  observedAt: string;
  action: "resolve" | "wrong" | "forget";
  resultingEpisode?: ProfileEpisodeRecord | null;
}

export interface BuildProfileMemoryFactReviewMutationEnvelopeInput {
  fact: ProfileFactRecord;
  sourceTaskId: string;
  sourceText: string;
  observedAt: string;
  action: "correct" | "forget";
  resultingFact?: ProfileFactRecord | null;
}

/**
 * Builds one bounded mutation envelope for an explicit user-driven memory-review mutation.
 *
 * @param input - Canonical review mutation inputs.
 * @returns Redaction-safe mutation envelope for the review mutation.
 */
export function buildProfileMemoryReviewMutationEnvelope(
  input: BuildProfileMemoryReviewMutationEnvelopeInput
): ProfileMemoryMutationEnvelope {
  const normalizedInputIdentity = buildNormalizedInputIdentity(input.sourceText);
  const governanceDecision = buildMemoryReviewMutationDecisionRecord(input);
  const redactionState = input.action === "forget" ? "value_redacted" : "not_requested";

  return {
    requestCorrelation: {
      sourceSurface: "memory_review_episode",
      normalizedInputIdentity
    },
    candidateRefs: governanceDecision.candidateRefs,
    governanceDecisions: [governanceDecision],
    appliedWriteRefs: governanceDecision.appliedWriteRefs,
    revisionLinkage: input.episodeId,
    rollbackHandle: buildRollbackHandle(
      input.sourceTaskId,
      normalizedInputIdentity,
      governanceDecision.candidateRefs,
      governanceDecision.appliedWriteRefs
    ),
    redactionState,
    retraction: buildMemoryReviewRetractionContract(input.action, redactionState)
  };
}

/**
 * Builds one bounded mutation envelope for an explicit user-driven fact-review mutation.
 *
 * @param input - Canonical fact-review mutation inputs.
 * @returns Redaction-safe mutation envelope for the fact-review mutation.
 */
export function buildProfileMemoryFactReviewMutationEnvelope(
  input: BuildProfileMemoryFactReviewMutationEnvelopeInput
): ProfileMemoryMutationEnvelope {
  const normalizedInputIdentity = buildNormalizedInputIdentity(input.sourceText);
  const governanceDecision = buildFactReviewMutationDecisionRecord(input);
  const redactionState = input.action === "forget" ? "value_redacted" : "not_requested";

  return {
    requestCorrelation: {
      sourceSurface: "memory_review_fact",
      normalizedInputIdentity
    },
    candidateRefs: governanceDecision.candidateRefs,
    governanceDecisions: [governanceDecision],
    appliedWriteRefs: governanceDecision.appliedWriteRefs,
    revisionLinkage: input.fact.id,
    rollbackHandle: buildRollbackHandle(
      input.sourceTaskId,
      normalizedInputIdentity,
      governanceDecision.candidateRefs,
      governanceDecision.appliedWriteRefs
    ),
    redactionState,
    retraction: buildFactReviewRetractionContract(input, redactionState)
  };
}

/**
 * Builds the bounded mutation-proof decision record for one explicit memory-review mutation.
 *
 * @param input - Review mutation inputs under normalization.
 * @returns Mutation-time decision record for the review mutation.
 */
function buildMemoryReviewMutationDecisionRecord(
  input: BuildProfileMemoryReviewMutationEnvelopeInput
): ProfileMemoryMutationDecisionRecord {
  return {
    family: "episode.resolution",
    evidenceClass: "user_explicit_fact",
    governanceAction: "allow_end_state",
    governanceReason: buildMemoryReviewGovernanceReason(input.action),
    candidateRefs: [buildCandidateRef("memory_review_episode", 0)],
    appliedWriteRefs: input.resultingEpisode ? [input.resultingEpisode.id] : [input.episodeId]
  };
}

/**
 * Builds the bounded mutation-proof decision record for one explicit fact-review mutation.
 *
 * @param input - Fact-review mutation inputs under normalization.
 * @returns Mutation-time decision record for the fact-review mutation.
 */
function buildFactReviewMutationDecisionRecord(
  input: BuildProfileMemoryFactReviewMutationEnvelopeInput
): ProfileMemoryMutationDecisionRecord {
  const family = inferGovernanceFamilyForNormalizedKey(
    input.fact.key.trim().toLowerCase(),
    input.resultingFact?.value ?? input.fact.value
  );

  return {
    family,
    evidenceClass: "user_explicit_fact",
    governanceAction: buildFactReviewGovernanceAction(family),
    governanceReason: buildFactReviewGovernanceReason(input.action),
    candidateRefs: [buildCandidateRef("memory_review_fact", 0)],
    appliedWriteRefs: input.resultingFact ? [input.resultingFact.id] : [input.fact.id]
  };
}

/**
 * Maps one explicit review mutation action onto its bounded governance reason.
 *
 * @param action - Review mutation action under normalization.
 * @returns Governance reason describing the explicit review mutation.
 */
function buildMemoryReviewGovernanceReason(
  action: BuildProfileMemoryReviewMutationEnvelopeInput["action"]
): ProfileMemoryGovernanceReason {
  if (action === "resolve") {
    return "memory_review_resolution";
  }
  if (action === "wrong") {
    return "memory_review_correction_override";
  }
  return "memory_review_forget_or_delete";
}

/**
 * Maps one explicit fact-review mutation action onto its bounded governance reason.
 *
 * @param action - Fact-review mutation action under normalization.
 * @returns Governance reason describing the explicit fact-review mutation.
 */
function buildFactReviewGovernanceReason(
  action: BuildProfileMemoryFactReviewMutationEnvelopeInput["action"]
): ProfileMemoryGovernanceReason {
  return action === "correct"
    ? "memory_review_correction_override"
    : "memory_review_forget_or_delete";
}

/**
 * Builds the bounded retraction contract for one explicit review mutation when that mutation is a
 * correction or delete path.
 *
 * @param action - Review mutation action under normalization.
 * @param redactionState - Envelope-level redaction state for the review mutation.
 * @returns Retraction contract for the review mutation, or `undefined` when not applicable.
 */
function buildMemoryReviewRetractionContract(
  action: BuildProfileMemoryReviewMutationEnvelopeInput["action"],
  redactionState: ProfileMemoryMutationEnvelope["redactionState"]
): ProfileMemoryMutationEnvelope["retraction"] {
  if (action === "resolve") {
    return undefined;
  }
  if (action === "wrong") {
    return {
      family: "episode.resolution",
      retractionClass: "correction_override",
      redactionState,
      clearsCompatibilityProjection: true,
      preservesAuditHandle: true
    };
  }
  return {
    family: "episode.resolution",
    retractionClass: "forget_or_delete",
    redactionState,
    clearsCompatibilityProjection: true,
    preservesAuditHandle: true
  };
}

/**
 * Builds the bounded retraction contract for one explicit fact-review mutation.
 *
 * @param input - Fact-review mutation input under normalization.
 * @param redactionState - Envelope-level redaction state for the review mutation.
 * @returns Retraction contract for the fact-review mutation.
 */
function buildFactReviewRetractionContract(
  input: BuildProfileMemoryFactReviewMutationEnvelopeInput,
  redactionState: ProfileMemoryMutationEnvelope["redactionState"]
): ProfileMemoryMutationEnvelope["retraction"] {
  const family = inferGovernanceFamilyForNormalizedKey(
    input.fact.key.trim().toLowerCase(),
    input.resultingFact?.value ?? input.fact.value
  );
  return {
    family,
    retractionClass: input.action === "correct" ? "correction_override" : "forget_or_delete",
    redactionState,
    clearsCompatibilityProjection: true,
    preservesAuditHandle: true
  };
}

/**
 * Derives the bounded governance-action label for one fact-review mutation target family.
 *
 * @param family - Canonical governed family being mutated.
 * @returns Mutation-time governance action label for the family.
 */
function buildFactReviewGovernanceAction(
  family: ReturnType<typeof inferGovernanceFamilyForNormalizedKey>
): ProfileMemoryMutationDecisionRecord["governanceAction"] {
  const familyEntry = getProfileMemoryFamilyRegistryEntry(family);
  if (familyEntry.currentStateEligible) {
    return "allow_current_state";
  }
  if (familyEntry.supportOnlyLegacyBehavior !== "disallowed") {
    return "support_only_legacy";
  }
  if (familyEntry.endStatePolicy !== "none") {
    return "allow_end_state";
  }
  return "quarantine";
}
