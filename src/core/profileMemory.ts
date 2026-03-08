/**
 * @fileoverview Defines temporal profile-memory types plus the stable public entrypoint for runtime helpers.
 */

export {
  extractProfileFactCandidatesFromUserInput
} from "./profileMemoryRuntime/profileMemoryExtraction";
export {
  isSensitiveKey,
  normalizeProfileKey,
  normalizeProfileValue
} from "./profileMemoryRuntime/profileMemoryNormalization";
export {
  buildPlanningContextFromProfile
} from "./profileMemoryRuntime/profileMemoryPlanningContext";
export {
  DEFAULT_PROFILE_STALE_AFTER_DAYS,
  PROFILE_MEMORY_SCHEMA_VERSION,
  assessProfileFactFreshness,
  createEmptyProfileMemoryState,
  markStaleFactsAsUncertain
} from "./profileMemoryRuntime/profileMemoryState";
export { upsertTemporalProfileFact } from "./profileMemoryRuntime/profileMemoryFactLifecycle";
export { normalizeProfileMemoryState } from "./profileMemoryRuntime/profileMemoryStateNormalization";

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

export interface ProfileMemoryState {
  schemaVersion: number;
  updatedAt: string;
  facts: ProfileFactRecord[];
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
