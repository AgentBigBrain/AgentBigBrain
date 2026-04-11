/**
 * @fileoverview Defines temporal profile-memory types plus the stable public entrypoint for runtime helpers.
 */

import type { ProfileEpisodeRecord } from "./profileMemoryRuntime/profileMemoryEpisodeContracts";
import type {
  ProfileMemoryGraphState as ProfileMemoryGraphStateShape
} from "./profileMemoryRuntime/profileMemoryGraphContracts";

export {
  extractProfileFactCandidatesFromUserInput
} from "./profileMemoryRuntime/profileMemoryExtraction";
export {
  clampProfileEpisodeConfidence,
  createProfileEpisodeRecord,
  isTerminalProfileEpisodeStatus,
  PROFILE_MEMORY_EPISODE_SCHEMA_VERSION
} from "./profileMemoryRuntime/profileMemoryEpisodeState";
export {
  applyProfileEpisodeCandidates,
  applyProfileEpisodeResolutions
} from "./profileMemoryRuntime/profileMemoryEpisodeMutations";
export {
  linkProfileEpisodeToContinuity,
  linkProfileEpisodesToContinuity
} from "./profileMemoryRuntime/profileMemoryEpisodeLinking";
export {
  queryProfileEpisodesForContinuity,
  readProfileEpisodes
} from "./profileMemoryRuntime/profileMemoryEpisodeQueries";
export {
  queryProfileFactsForContinuity,
  readProfileFacts
} from "./profileMemoryRuntime/profileMemoryQueries";
export {
  PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
  PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME,
  PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
  PROFILE_MEMORY_GRAPH_SCHEMA_VERSION
} from "./profileMemoryRuntime/profileMemoryGraphContracts";
export {
  PROFILE_MEMORY_FAMILY_REGISTRY,
  PROFILE_MEMORY_FAMILY_REGISTRY_VERSION,
  getProfileMemoryFamilyRegistryEntry
} from "./profileMemoryRuntime/profileMemoryFamilyRegistry";
export {
  buildProfileMemoryGraphIndexState,
  buildProfileMemoryGraphReadModel,
  createEmptyProfileMemoryGraphIndexState,
  createEmptyProfileMemoryGraphReadModel
} from "./profileMemoryRuntime/profileMemoryGraphIndexing";
export {
  createEmptyProfileMemoryGraphState,
  normalizeProfileMemoryGraphState
} from "./profileMemoryRuntime/profileMemoryGraphState";
export {
  createEmptyProfileMemoryMutationJournalState,
  normalizeProfileMemoryMutationJournalState
} from "./profileMemoryRuntime/profileMemoryMutationJournal";
export {
  buildInferredProfileEpisodeResolutionCandidates
} from "./profileMemoryRuntime/profileMemoryEpisodeResolution";
export {
  assessProfileEpisodeFreshness,
  buildProfileEpisodeConsolidationKey,
  compareProfileEpisodesForLifecyclePriority,
  consolidateProfileEpisodes
} from "./profileMemoryRuntime/profileMemoryEpisodeConsolidation";
export {
  extractProfileEpisodeCandidatesFromUserInput
} from "./profileMemoryRuntime/profileMemoryEpisodeExtraction";
export {
  parseProfileMediaIngestInput
} from "./profileMemoryRuntime/profileMemoryMediaIngest";
export type { ProfileMemoryIngestOptions } from "./profileMemoryStore";
export {
  isSensitiveKey,
  normalizeProfileKey,
  normalizeProfileValue
} from "./profileMemoryRuntime/profileMemoryNormalization";
export type {
  AgentPulseContextDriftAssessment,
  AgentPulseContextDriftDomain,
  AgentPulseEvaluationRequest,
  AgentPulseEvaluationResult,
  AgentPulseRelationshipAssessment,
  AgentPulseRelationshipRole,
  ProfileAccessPurpose,
  ProfileAccessRequest,
  ProfileEpisodeReviewMutationResult,
  ProfileFactPlanningInspectionEntry,
  ProfileFactPlanningInspectionRequest,
  ProfileFactPlanningInspectionResult,
  ProfileFactReviewEntry,
  ProfileFactReviewMutationAction,
  ProfileFactReviewMutationRequest,
  ProfileFactReviewMutationResult,
  ProfileFactReviewRequest,
  ProfileFactReviewResult,
  ProfileIngestResult,
  ProfileMemoryIngestRequest,
  ProfileMemoryRequestTelemetry,
  ProfileMemorySourceSurface,
  ProfileMemoryWriteProvenance,
  ProfilePulseRelevantEpisode,
  ProfileReadableEpisode,
  ProfileReadableFact,
  ProfileValidatedFactCandidateInput
} from "./profileMemoryRuntime/contracts";
export type {
  ProfileMemoryAsOfContract,
  ProfileMemoryMutationDecisionRecord,
  ProfileMemoryQueryDecisionDisposition,
  ProfileMemoryQueryDecisionRecord
} from "./profileMemoryRuntime/profileMemoryDecisionRecordContracts";
export type {
  ProfileMemoryMutationEnvelope,
  ProfileMemoryMutationRequestCorrelation
} from "./profileMemoryRuntime/profileMemoryMutationEnvelopeContracts";
export type {
  ProfileMemoryRetractionClass,
  ProfileMemoryRetractionContract,
  ProfileMemoryRetractionRedactionState
} from "./profileMemoryRuntime/profileMemoryRetractionContracts";
export { normalizeProfileMemoryEpisodes } from "./profileMemoryRuntime/profileMemoryEpisodeNormalization";
export {
  buildPlanningContextFromProfile
} from "./profileMemoryRuntime/profileMemoryPlanningContext";
export {
  selectProfileFactsForQuery
} from "./profileMemoryRuntime/profileMemoryPlanningContext";
export {
  buildProfileEpisodePlanningContext
} from "./profileMemoryRuntime/profileMemoryEpisodePlanningContext";
export {
  DEFAULT_PROFILE_STALE_AFTER_DAYS,
  PROFILE_MEMORY_SCHEMA_VERSION,
  assessProfileFactFreshness,
  createEmptyProfileMemoryState,
  markStaleFactsAsUncertain
} from "./profileMemoryRuntime/profileMemoryState";
export { upsertTemporalProfileFact } from "./profileMemoryRuntime/profileMemoryFactLifecycle";
export { normalizeProfileMemoryState } from "./profileMemoryRuntime/profileMemoryStateNormalization";
export type {
  CreateProfileEpisodeRecordInput,
  ProfileEpisodeRecord,
  ProfileEpisodeResolutionInput,
  ProfileEpisodeResolutionStatus,
  ProfileEpisodeSourceKind,
  ProfileEpisodeStatus
} from "./profileMemoryRuntime/profileMemoryEpisodeContracts";
export type {
  GovernedProfileEpisodeCandidate,
  GovernedProfileEpisodeResolution,
  GovernedProfileFactCandidate,
  ProfileMemoryAdjacentDomain,
  ProfileMemoryAdjacentDomainAccess,
  ProfileMemoryAdjacentDomainPolicy,
  ProfileMemoryAnswerModeFallback,
  ProfileMemoryCompatibilityProjectionPolicy,
  ProfileMemoryCorroborationMode,
  ProfileMemoryDisplacementPolicy,
  ProfileMemoryEndStatePolicy,
  ProfileMemoryEvidenceClass,
  ProfileMemoryFamilyRegistryEntry,
  ProfileMemoryGovernanceAction,
  ProfileMemoryGovernanceCardinality,
  ProfileMemoryGovernanceDecision,
  ProfileMemoryGovernanceFamily,
  ProfileMemoryGovernanceReason,
  ProfileMemoryInventoryPolicy,
  ProfileMemoryMinimumSensitivityFloor,
  ProfileMemorySourceAuthorityMode,
  ProfileMemorySupportOnlyLegacyBehavior,
  ProfileMemoryTruthGovernanceResult
} from "./profileMemoryRuntime/profileMemoryTruthGovernanceContracts";
export type {
  ProfileMemoryGraphClaimPayloadV1,
  ProfileMemoryGraphClaimRecord,
  ProfileMemoryGraphCompactionStateV1,
  ProfileMemoryGraphEventPayloadV1,
  ProfileMemoryGraphEventRecord,
  ProfileMemoryGraphIndexStateV1,
  ProfileMemoryGraphObservationPayloadV1,
  ProfileMemoryGraphObservationRecord,
  ProfileMemoryGraphReadModelV1,
  ProfileMemoryGraphSourceTier,
  ProfileMemoryGraphState,
  ProfileMemoryGraphTimePrecision,
  ProfileMemoryGraphTimeSource,
  ProfileMemoryMutationJournalEntryV1,
  ProfileMemoryMutationJournalStateV1
} from "./profileMemoryRuntime/profileMemoryGraphContracts";

export type ProfileFactStatus = "confirmed" | "uncertain" | "superseded";

export type ProfileMutationAuditClassifier = "commitment_signal";

export type ProfileMutationAuditCategory =
  | "TOPIC_RESOLUTION_CANDIDATE"
  | "GENERIC_RESOLUTION"
  | "RESOLVED_MARKER"
  | "NO_SIGNAL"
  | "UNCLEAR";

export type ProfileMutationAuditConfidenceTier = "HIGH" | "MED" | "LOW";

export interface ProfileMutationAuditMetadataV1 {
  classifier: ProfileMutationAuditClassifier;
  category: ProfileMutationAuditCategory;
  confidenceTier: ProfileMutationAuditConfidenceTier;
  matchedRuleId: string;
  rulepackVersion: string;
  conflict: boolean;
}

export interface ProfileFactRecord {
  id: string;
  key: string;
  value: string;
  sensitive: boolean;
  status: ProfileFactStatus;
  confidence: number;
  sourceTaskId: string;
  source: string;
  observedAt: string;
  confirmedAt: string | null;
  supersededAt: string | null;
  lastUpdatedAt: string;
  mutationAudit?: ProfileMutationAuditMetadataV1;
}

export interface ProfileMemoryIngestReceiptRecord {
  receiptKey: string;
  turnId: string;
  sourceFingerprint: string;
  sourceTaskId: string;
  recordedAt: string;
}

/**
 * Canonical persisted profile-memory envelope.
 *
 * **Why it exists:**
 * The encrypted store still carries retained compatibility facts and episodes for stable older
 * read surfaces, but the additive graph is now the authoritative internal truth owner. Keeping
 * that hierarchy explicit here prevents future runtime code from treating persisted compatibility
 * arrays as a second co-equal truth surface.
 *
 * **What it talks to:**
 * - Uses `ProfileMemoryGraphStateShape` (import type) from
 *   `./profileMemoryRuntime/profileMemoryGraphContracts`.
 * - Uses retained fact and episode contracts exported from this module.
 */
export interface ProfileMemoryState {
  schemaVersion: number;
  updatedAt: string;
  /** Derived compatibility cache kept for stable legacy reads during the cleanup window. */
  facts: ProfileFactRecord[];
  /** Derived compatibility cache kept for stable legacy episodic reads during the cleanup window. */
  episodes: ProfileEpisodeRecord[];
  ingestReceipts: ProfileMemoryIngestReceiptRecord[];
  /** Authoritative graph-backed truth surface for temporal relational memory. */
  graph: ProfileMemoryGraphStateShape;
}

export interface ProfileFactUpsertInput {
  key: string;
  value: string;
  sensitive: boolean;
  sourceTaskId: string;
  source: string;
  observedAt?: string;
  confidence?: number;
  mutationAudit?: ProfileMutationAuditMetadataV1 | null;
}

export interface ProfileUpsertResult {
  nextState: ProfileMemoryState;
  upsertedFact: ProfileFactRecord;
  supersededFactIds: string[];
  applied: boolean;
}

export interface ProfileFreshnessAssessment {
  stale: boolean;
  ageDays: number;
}

