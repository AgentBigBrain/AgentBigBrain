/**
 * @fileoverview Bounded mutation-envelope helpers for provenance-backed profile-memory writes.
 */

import type { ProfileFactRecord, ProfileMemoryState } from "../profileMemory";
import type { ProfileMemoryWriteProvenance } from "./contracts";
import type {
  CreateProfileEpisodeRecordInput,
  ProfileEpisodeResolutionInput
} from "./profileMemoryEpisodeContracts";
import type { ProfileMemoryMutationDecisionRecord } from "./profileMemoryDecisionRecordContracts";
import type { ProfileMemoryMutationEnvelope } from "./profileMemoryMutationEnvelopeContracts";
import {
  buildCandidateRef,
  buildNormalizedInputIdentity,
  buildRollbackHandle,
  dedupeRefs
} from "./profileMemoryMutationEnvelopeSupport";
import { normalizeProfileValue } from "./profileMemoryNormalization";
export type {
  BuildProfileMemoryFactReviewMutationEnvelopeInput,
  BuildProfileMemoryReviewMutationEnvelopeInput
} from "./profileMemoryReviewMutationEnvelope";
export {
  buildProfileMemoryFactReviewMutationEnvelope,
  buildProfileMemoryReviewMutationEnvelope
} from "./profileMemoryReviewMutationEnvelope";
import type {
  GovernedProfileEpisodeCandidate,
  GovernedProfileEpisodeResolution,
  GovernedProfileFactCandidate
} from "./profileMemoryTruthGovernanceContracts";

export interface BuildProfileMemoryIngestMutationEnvelopeInput {
  sourceTaskId: string;
  userInput: string;
  provenance: ProfileMemoryWriteProvenance;
  finalState: ProfileMemoryState;
  factDecisions: readonly GovernedProfileFactCandidate[];
  episodeDecisions: readonly GovernedProfileEpisodeCandidate[];
  episodeResolutionDecisions: readonly GovernedProfileEpisodeResolution[];
}

/**
 * Builds one bounded mutation envelope for a canonical provenance-backed ingest attempt.
 *
 * @param input - Canonical ingest mutation inputs.
 * @returns Redaction-safe mutation envelope for the write attempt.
 */
export function buildProfileMemoryIngestMutationEnvelope(
  input: BuildProfileMemoryIngestMutationEnvelopeInput
): ProfileMemoryMutationEnvelope {
  const factDecisionRecords = input.factDecisions.map((entry, index) =>
    toFactMutationDecisionRecord(input.finalState, entry, index)
  );
  const episodeDecisionRecords = input.episodeDecisions.map((entry, index) =>
    toEpisodeMutationDecisionRecord(input.finalState, entry, index)
  );
  const episodeResolutionDecisionRecords = input.episodeResolutionDecisions.map((entry, index) =>
    toEpisodeResolutionMutationDecisionRecord(input.finalState, entry, index)
  );
  const governanceDecisions = [
    ...factDecisionRecords,
    ...episodeDecisionRecords,
    ...episodeResolutionDecisionRecords
  ];
  const candidateRefs = governanceDecisions.flatMap((decision) => decision.candidateRefs);
  const appliedWriteRefs = dedupeRefs(
    governanceDecisions.flatMap((decision) => decision.appliedWriteRefs)
  );
  const normalizedInputIdentity = buildNormalizedInputIdentity(
    input.userInput,
    input.provenance.sourceFingerprint
  );

  return {
    requestCorrelation: {
      conversationId: input.provenance.conversationId,
      turnId: input.provenance.turnId,
      dominantLaneAtWrite: input.provenance.dominantLaneAtWrite,
      threadKey: input.provenance.threadKey,
      sourceSurface: input.provenance.sourceSurface,
      sourceFingerprint: input.provenance.sourceFingerprint,
      ...(input.provenance.sourceRecallRefs && input.provenance.sourceRecallRefs.length > 0
        ? { sourceRecallRefs: input.provenance.sourceRecallRefs }
        : {}),
      normalizedInputIdentity
    },
    candidateRefs,
    governanceDecisions,
    appliedWriteRefs,
    revisionLinkage: input.provenance.turnId ?? input.sourceTaskId,
    rollbackHandle: buildRollbackHandle(
      input.sourceTaskId,
      normalizedInputIdentity,
      candidateRefs,
      appliedWriteRefs
    ),
    redactionState: "not_requested"
  };
}

/**
 * Converts one governed fact decision into the bounded mutation-proof shape.
 *
 * @param finalState - Final profile-memory state after canonical ingest mutation.
 * @param entry - Governed fact candidate plus deterministic decision.
 * @param index - Stable candidate index for bounded reference generation.
 * @returns Mutation-time decision record for one fact candidate.
 */
function toFactMutationDecisionRecord(
  finalState: ProfileMemoryState,
  entry: GovernedProfileFactCandidate,
  index: number
): ProfileMemoryMutationDecisionRecord {
  return {
    family: entry.decision.family,
    evidenceClass: entry.decision.evidenceClass,
    governanceAction: entry.decision.action,
    governanceReason: entry.decision.reason,
    candidateRefs: [buildCandidateRef("fact", index)],
    appliedWriteRefs: findAppliedFactRefs(finalState, entry.candidate)
  };
}

/**
 * Converts one governed episode-candidate decision into the bounded mutation-proof shape.
 *
 * @param finalState - Final profile-memory state after canonical ingest mutation.
 * @param entry - Governed episode candidate plus deterministic decision.
 * @param index - Stable candidate index for bounded reference generation.
 * @returns Mutation-time decision record for one episode candidate.
 */
function toEpisodeMutationDecisionRecord(
  finalState: ProfileMemoryState,
  entry: GovernedProfileEpisodeCandidate,
  index: number
): ProfileMemoryMutationDecisionRecord {
  return {
    family: entry.decision.family,
    evidenceClass: entry.decision.evidenceClass,
    governanceAction: entry.decision.action,
    governanceReason: entry.decision.reason,
    candidateRefs: [buildCandidateRef("episode", index)],
    appliedWriteRefs: findAppliedEpisodeCandidateRefs(finalState, entry.candidate)
  };
}

/**
 * Converts one governed episode-resolution decision into the bounded mutation-proof shape.
 *
 * @param finalState - Final profile-memory state after canonical ingest mutation.
 * @param entry - Governed episode-resolution candidate plus deterministic decision.
 * @param index - Stable candidate index for bounded reference generation.
 * @returns Mutation-time decision record for one episode-resolution candidate.
 */
function toEpisodeResolutionMutationDecisionRecord(
  finalState: ProfileMemoryState,
  entry: GovernedProfileEpisodeResolution,
  index: number
): ProfileMemoryMutationDecisionRecord {
  return {
    family: entry.decision.family,
    evidenceClass: entry.decision.evidenceClass,
    governanceAction: entry.decision.action,
    governanceReason: entry.decision.reason,
    candidateRefs: [buildCandidateRef("episode_resolution", index)],
    appliedWriteRefs: findAppliedEpisodeResolutionRefs(finalState, entry.candidate)
  };
}

/**
 * Locates the canonical fact ids written by one governed fact candidate.
 *
 * @param state - Final profile-memory state after canonical ingest mutation.
 * @param candidate - Governed fact candidate under inspection.
 * @returns Bounded fact ids touched by the candidate.
 */
function findAppliedFactRefs(
  state: ProfileMemoryState,
  candidate: GovernedProfileFactCandidate["candidate"]
): readonly string[] {
  return dedupeRefs(
    state.facts
      .filter((fact) => matchesAppliedFact(fact, candidate))
      .map((fact) => fact.id)
  );
}

/**
 * Returns whether one stored fact is the canonical write target for one governed fact candidate.
 *
 * @param fact - Stored fact under inspection.
 * @param candidate - Governed fact candidate under inspection.
 * @returns `true` when the stored fact reflects the candidate write.
 */
function matchesAppliedFact(
  fact: ProfileFactRecord,
  candidate: GovernedProfileFactCandidate["candidate"]
): boolean {
  return fact.key === candidate.key &&
    fact.value === candidate.value &&
    fact.sourceTaskId === candidate.sourceTaskId &&
    fact.source === candidate.source &&
    fact.observedAt === (candidate.observedAt ?? fact.observedAt);
}

/**
 * Locates the canonical episode ids written by one governed episode candidate.
 *
 * @param state - Final profile-memory state after canonical ingest mutation.
 * @param candidate - Governed episode candidate under inspection.
 * @returns Bounded episode ids touched by the candidate.
 */
function findAppliedEpisodeCandidateRefs(
  state: ProfileMemoryState,
  candidate: CreateProfileEpisodeRecordInput
): readonly string[] {
  const normalizedTitle = normalizeProfileValue(candidate.title);
  const normalizedSummary = normalizeProfileValue(candidate.summary);
  return dedupeRefs(
    state.episodes
      .filter((episode) =>
        episode.sourceTaskId === candidate.sourceTaskId &&
        episode.source === candidate.source &&
        normalizeProfileValue(episode.title) === normalizedTitle &&
        normalizeProfileValue(episode.summary) === normalizedSummary
      )
      .map((episode) => episode.id)
  );
}

/**
 * Locates the canonical episode id touched by one governed episode-resolution candidate.
 *
 * @param state - Final profile-memory state after canonical ingest mutation.
 * @param candidate - Governed episode-resolution candidate under inspection.
 * @returns Bounded episode id touched by the resolution candidate.
 */
function findAppliedEpisodeResolutionRefs(
  state: ProfileMemoryState,
  candidate: ProfileEpisodeResolutionInput
): readonly string[] {
  const matchedEpisode = state.episodes.find((episode) =>
    episode.id === candidate.episodeId &&
    episode.sourceTaskId === candidate.sourceTaskId &&
    episode.source === candidate.source
  );
  return matchedEpisode ? [matchedEpisode.id] : [];
}
