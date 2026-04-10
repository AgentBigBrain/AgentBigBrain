/**
 * @fileoverview Canonical bounded contracts for graph-backed temporal retrieval and synthesis.
 */

import type {
  ProfileMemoryGraphSourceTier,
  ProfileMemoryGraphStableRefResolution
} from "./profileMemoryGraphContracts";
import type { ProfileMemoryGovernanceFamily } from "./profileMemoryTruthGovernanceContracts";

export const PROFILE_MEMORY_TEMPORAL_RELEVANCE_SCOPES = [
  "thread_local",
  "conversation_local",
  "global_profile"
] as const;

export type ProfileMemoryTemporalRelevanceScope =
  (typeof PROFILE_MEMORY_TEMPORAL_RELEVANCE_SCOPES)[number];

export const PROFILE_MEMORY_TEMPORAL_SEMANTIC_MODES = [
  "identity",
  "relationship_inventory",
  "event_history"
] as const;

export type ProfileMemoryTemporalSemanticMode =
  (typeof PROFILE_MEMORY_TEMPORAL_SEMANTIC_MODES)[number];

export const PROFILE_MEMORY_TEMPORAL_ANSWER_MODES = [
  "current",
  "historical",
  "ambiguous",
  "insufficient_evidence",
  "quarantined_identity"
] as const;

export type ProfileMemoryTemporalAnswerMode =
  (typeof PROFILE_MEMORY_TEMPORAL_ANSWER_MODES)[number];

export const PROFILE_MEMORY_TEMPORAL_LANE_KINDS = [
  "current_state",
  "historical_context",
  "contradiction_notes",
  "insufficient_evidence",
  "quarantined_identity"
] as const;

export type ProfileMemoryTemporalLaneKind =
  (typeof PROFILE_MEMORY_TEMPORAL_LANE_KINDS)[number];

export const PROFILE_MEMORY_TEMPORAL_REJECTION_REASONS = [
  "outside_as_of_window",
  "not_current_state_eligible",
  "corroboration_required",
  "lower_source_authority",
  "prior_winner_retained",
  "authoritative_successor",
  "ambiguous_singular_conflict",
  "historical_only",
  "quarantined_identity",
  "bounded_inventory_overflow"
] as const;

export type ProfileMemoryTemporalRejectionReason =
  (typeof PROFILE_MEMORY_TEMPORAL_REJECTION_REASONS)[number];

export interface ProfileMemoryTemporalQueryCaps {
  maxFocusEntities: number;
  maxClaimFamiliesPerFocusEntity: number;
  maxCandidateClaimsPerFamily: number;
  maxEventsPerFocusEntity: number;
  maxObservationsPerCluster: number;
  maxContradictionNotes: number;
}

export const DEFAULT_PROFILE_MEMORY_TEMPORAL_QUERY_CAPS: ProfileMemoryTemporalQueryCaps = {
  maxFocusEntities: 3,
  maxClaimFamiliesPerFocusEntity: 5,
  maxCandidateClaimsPerFamily: 6,
  maxEventsPerFocusEntity: 3,
  maxObservationsPerCluster: 4,
  maxContradictionNotes: 2
};

export interface ProfileMemoryTemporalQueryRequest {
  semanticMode: ProfileMemoryTemporalSemanticMode;
  relevanceScope: ProfileMemoryTemporalRelevanceScope;
  entityHints: readonly string[];
  queryText?: string;
  asOfValidTime?: string;
  asOfObservedTime?: string;
  caps?: Partial<ProfileMemoryTemporalQueryCaps>;
}

export interface ProfileMemoryTemporalObservationEvidence {
  observationId: string;
  stableRefId: string | null;
  family: string | null;
  normalizedKey: string | null;
  normalizedValue: string | null;
  assertedAt: string;
  observedAt: string;
  sourceTier: ProfileMemoryGraphSourceTier;
  entityRefIds: readonly string[];
}

export interface ProfileMemoryTemporalClaimEvidence {
  claimId: string;
  stableRefId: string | null;
  family: ProfileMemoryGovernanceFamily;
  normalizedKey: string;
  normalizedValue: string | null;
  assertedAt: string;
  validFrom: string | null;
  validTo: string | null;
  endedAt: string | null;
  active: boolean;
  sourceTier: ProfileMemoryGraphSourceTier;
  entityRefIds: readonly string[];
  supportingObservationIds: readonly string[];
}

export interface ProfileMemoryTemporalEventEvidence {
  eventId: string;
  stableRefId: string | null;
  family: string | null;
  title: string;
  summary: string;
  assertedAt: string;
  observedAt: string;
  validFrom: string | null;
  validTo: string | null;
  sourceTier: ProfileMemoryGraphSourceTier;
  entityRefIds: readonly string[];
  supportingObservationIds: readonly string[];
}

export interface ProfileMemoryTemporalLifecycleBuckets {
  current: readonly string[];
  historical: readonly string[];
  ended: readonly string[];
  overflowNote: string | null;
}

export interface ProfileMemoryTemporalClaimFamilySlice {
  family: ProfileMemoryGovernanceFamily;
  claims: readonly ProfileMemoryTemporalClaimEvidence[];
  lifecycleBuckets: ProfileMemoryTemporalLifecycleBuckets;
}

export interface ProfileMemoryTemporalEventSlice {
  events: readonly ProfileMemoryTemporalEventEvidence[];
  lifecycleBuckets: ProfileMemoryTemporalLifecycleBuckets;
}

export interface ProfileMemoryTemporalFocusEntitySlice {
  stableRefId: string;
  resolution: ProfileMemoryGraphStableRefResolution;
  matchedHintTerms: readonly string[];
  claimFamilies: readonly ProfileMemoryTemporalClaimFamilySlice[];
  eventSlice: ProfileMemoryTemporalEventSlice;
  observationsById: Readonly<Record<string, ProfileMemoryTemporalObservationEvidence>>;
  degradedNotes: readonly string[];
}

export interface ProfileMemoryTemporalEvidenceSlice {
  semanticMode: ProfileMemoryTemporalSemanticMode;
  relevanceScope: ProfileMemoryTemporalRelevanceScope;
  asOfValidTime: string | null;
  asOfObservedTime: string | null;
  caps: ProfileMemoryTemporalQueryCaps;
  focusEntities: readonly ProfileMemoryTemporalFocusEntitySlice[];
  degradedNotes: readonly string[];
}

export interface ProfileMemoryTemporalRejectedClaimRecord {
  claimId: string;
  reason: ProfileMemoryTemporalRejectionReason;
}

export interface ProfileMemoryTemporalLaneMetadata {
  laneId: string;
  focusStableRefId: string;
  family: ProfileMemoryGovernanceFamily | null;
  answerMode: ProfileMemoryTemporalAnswerMode;
  dominantLane: ProfileMemoryTemporalLaneKind;
  supportingLanes: readonly ProfileMemoryTemporalLaneKind[];
  chosenClaimId: string | null;
  supportingObservationIds: readonly string[];
  rejectedClaims: readonly ProfileMemoryTemporalRejectedClaimRecord[];
  lifecycleBuckets: ProfileMemoryTemporalLifecycleBuckets;
  degradedNotes: readonly string[];
}

export interface ProfileMemoryTemporalSynthesisProof {
  synthesisVersion: "v1";
  semanticMode: ProfileMemoryTemporalSemanticMode;
  relevanceScope: ProfileMemoryTemporalRelevanceScope;
  asOfValidTime: string | null;
  asOfObservedTime: string | null;
  focusStableRefIds: readonly string[];
  degradedNotes: readonly string[];
}

export interface TemporalMemorySynthesis {
  currentState: readonly string[];
  historicalContext: readonly string[];
  contradictionNotes: readonly string[];
  answerMode: ProfileMemoryTemporalAnswerMode;
  proof: ProfileMemoryTemporalSynthesisProof;
  laneMetadata: readonly ProfileMemoryTemporalLaneMetadata[];
}
