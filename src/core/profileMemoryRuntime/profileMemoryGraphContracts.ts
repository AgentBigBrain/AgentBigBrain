/**
 * @fileoverview Additive graph-backed personal-memory contracts for Phase 3 persistence.
 */

import type { SchemaEnvelopeV1 } from "../types";

export const PROFILE_MEMORY_GRAPH_SCHEMA_VERSION = "v1";
export const PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME = "ProfileMemoryGraphObservationV1";
export const PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME = "ProfileMemoryGraphClaimV1";
export const PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME = "ProfileMemoryGraphEventV1";

export type ProfileMemoryGraphSourceTier =
  | "explicit_user_statement"
  | "validated_structured_candidate"
  | "reconciliation_or_projection"
  | "assistant_inference";

export type ProfileMemoryGraphTimePrecision = "instant" | "day" | "unknown";

export type ProfileMemoryGraphTimeSource =
  | "observed_at"
  | "asserted_at"
  | "user_stated"
  | "inferred"
  | "system_generated";

export type ProfileMemoryGraphRedactionState = "not_requested" | "redacted";

export type ProfileMemoryGraphStableRefResolution =
  | "resolved_current"
  | "quarantined"
  | "provisional";

export type ProfileMemoryGraphDecisionActionV1 =
  | "merge"
  | "quarantine"
  | "unquarantine"
  | "rekey"
  | "rollback";

export interface ProfileMemoryGraphObservationPayloadV1 {
  observationId: string;
  stableRefId: string | null;
  family: string | null;
  normalizedKey: string | null;
  normalizedValue: string | null;
  redactionState?: ProfileMemoryGraphRedactionState;
  redactedAt?: string | null;
  sensitive: boolean;
  sourceTaskId: string | null;
  sourceFingerprint: string;
  sourceTier: ProfileMemoryGraphSourceTier;
  assertedAt: string;
  observedAt: string;
  timePrecision: ProfileMemoryGraphTimePrecision;
  timeSource: ProfileMemoryGraphTimeSource;
  entityRefIds: string[];
}

export interface ProfileMemoryGraphClaimPayloadV1 {
  claimId: string;
  stableRefId: string | null;
  family: string;
  normalizedKey: string;
  normalizedValue: string | null;
  redactionState?: ProfileMemoryGraphRedactionState;
  redactedAt?: string | null;
  sensitive: boolean;
  sourceTaskId: string | null;
  sourceFingerprint: string;
  sourceTier: ProfileMemoryGraphSourceTier;
  assertedAt: string;
  validFrom: string | null;
  validTo: string | null;
  endedAt: string | null;
  endedByClaimId: string | null;
  timePrecision: ProfileMemoryGraphTimePrecision;
  timeSource: ProfileMemoryGraphTimeSource;
  derivedFromObservationIds: string[];
  projectionSourceIds: string[];
  entityRefIds: string[];
  active: boolean;
}

export interface ProfileMemoryGraphEventPayloadV1 {
  eventId: string;
  stableRefId: string | null;
  family: string | null;
  title: string;
  summary: string;
  redactionState?: ProfileMemoryGraphRedactionState;
  redactedAt?: string | null;
  sensitive: boolean;
  sourceTaskId: string | null;
  sourceFingerprint: string;
  sourceTier: ProfileMemoryGraphSourceTier;
  assertedAt: string;
  observedAt: string;
  validFrom: string | null;
  validTo: string | null;
  timePrecision: ProfileMemoryGraphTimePrecision;
  timeSource: ProfileMemoryGraphTimeSource;
  derivedFromObservationIds: string[];
  projectionSourceIds: string[];
  entityRefIds: string[];
}

export type ProfileMemoryGraphObservationRecord =
  SchemaEnvelopeV1<ProfileMemoryGraphObservationPayloadV1>;

export type ProfileMemoryGraphClaimRecord = SchemaEnvelopeV1<ProfileMemoryGraphClaimPayloadV1>;

export type ProfileMemoryGraphEventRecord = SchemaEnvelopeV1<ProfileMemoryGraphEventPayloadV1>;

export interface ProfileMemoryMutationJournalEntryV1 {
  journalEntryId: string;
  watermark: number;
  recordedAt: string;
  sourceTaskId: string | null;
  sourceFingerprint: string | null;
  mutationEnvelopeHash: string | null;
  observationIds: string[];
  claimIds: string[];
  eventIds: string[];
  redactionState: "not_requested" | "requested" | "redacted";
}

export interface ProfileMemoryMutationJournalStateV1 {
  schemaVersion: "v1";
  nextWatermark: number;
  entries: ProfileMemoryMutationJournalEntryV1[];
}

export interface ProfileMemoryGraphValidityWindowIndexEntryV1 {
  recordType: "claim" | "event";
  recordId: string;
  validFrom: string | null;
  validTo: string | null;
  active: boolean;
}

export interface ProfileMemoryGraphIndexStateV1 {
  schemaVersion: "v1";
  byEntityRefId: Record<string, string[]>;
  byFamily: Record<string, string[]>;
  validityWindow: ProfileMemoryGraphValidityWindowIndexEntryV1[];
  bySourceTier: Record<ProfileMemoryGraphSourceTier, string[]>;
  activeClaimIds: string[];
}

export interface ProfileMemoryGraphReadModelV1 {
  schemaVersion: "v1";
  watermark: number;
  rebuiltAt: string | null;
  currentClaimIdsByKey: Record<string, string>;
  conflictingCurrentClaimIdsByKey: Record<string, string[]>;
  inventoryClaimIdsByFamily: Record<string, string[]>;
}

export interface ProfileMemoryGraphCompactionStateV1 {
  schemaVersion: "v1";
  snapshotWatermark: number;
  lastCompactedAt: string | null;
  maxObservationCount: number;
  maxClaimCount: number;
  maxEventCount: number;
  maxJournalEntries: number;
}

export interface ProfileMemoryGraphDecisionRecordV1 {
  decisionId: string;
  action: ProfileMemoryGraphDecisionActionV1;
  recordedAt: string;
  fromStableRefId: string | null;
  toStableRefId: string | null;
  sourceTaskId: string | null;
  sourceFingerprint: string | null;
  mutationEnvelopeHash: string | null;
  observationIds: string[];
  claimIds: string[];
  eventIds: string[];
}

export interface ProfileMemoryGraphState {
  schemaVersion: "v1";
  updatedAt: string;
  observations: ProfileMemoryGraphObservationRecord[];
  claims: ProfileMemoryGraphClaimRecord[];
  events: ProfileMemoryGraphEventRecord[];
  decisionRecords?: ProfileMemoryGraphDecisionRecordV1[];
  mutationJournal: ProfileMemoryMutationJournalStateV1;
  indexes: ProfileMemoryGraphIndexStateV1;
  readModel: ProfileMemoryGraphReadModelV1;
  compaction: ProfileMemoryGraphCompactionStateV1;
}
