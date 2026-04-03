/**
 * @fileoverview Defines temporal profile-memory types plus the stable public entrypoint for runtime helpers.
 */

import type { ProfileEpisodeRecord } from "./profileMemoryRuntime/profileMemoryEpisodeContracts";

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

export interface ProfileMemoryState {
  schemaVersion: number;
  updatedAt: string;
  facts: ProfileFactRecord[];
  episodes: ProfileEpisodeRecord[];
  ingestReceipts: ProfileMemoryIngestReceiptRecord[];
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
}

export interface ProfileFreshnessAssessment {
  stale: boolean;
  ageDays: number;
}

