/**
 * @fileoverview Fail-closed graph metadata, semantic-identity, and bounded event-text normalization helpers for additive graph state.
 */

import { sha256HexFromCanonicalJson } from "../normalizers/canonicalizationRules";
import {
  PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
  PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME,
  PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME
} from "./profileMemoryGraphContracts";
import type {
  ProfileMemoryGraphClaimRecord,
  ProfileMemoryGraphEventRecord,
  ProfileMemoryGraphObservationRecord
} from "./profileMemoryGraphContracts";
import { rebuildProfileMemoryGraphEnvelope } from "./profileMemoryGraphStateSupport";

const UNTITLED_EVENT_PLACEHOLDER = "[untitled episode]";
const EMPTY_EVENT_SUMMARY_PLACEHOLDER = "[missing episode summary]";

/**
 * Repairs observation metadata and semantic identity so blank or padded persisted strings do not
 * survive as canonical values.
 *
 * @param input - Canonical observations plus one deterministic fallback timestamp.
 * @returns Repaired observations and whether any metadata changed.
 */
export function normalizeProfileMemoryGraphObservationMetadata(input: {
  observations: readonly ProfileMemoryGraphObservationRecord[];
  recordedAt: string;
}): {
  nextObservations: ProfileMemoryGraphObservationRecord[];
  changed: boolean;
} {
  let changed = false;
  const nextObservations = input.observations.map((observation) => {
    const nextObservation = normalizeProfileMemoryGraphObservationMetadataRecord({
      observation,
      recordedAt: input.recordedAt
    });
    if (nextObservation !== observation) {
      changed = true;
    }
    return nextObservation;
  });

  return {
    nextObservations,
    changed
  };
}

/**
 * Repairs claim metadata and semantic identity so blank or padded persisted strings do not survive
 * as canonical values.
 *
 * @param input - Canonical claims plus one deterministic fallback timestamp.
 * @returns Repaired claims and whether any metadata changed.
 */
export function normalizeProfileMemoryGraphClaimMetadata(input: {
  claims: readonly ProfileMemoryGraphClaimRecord[];
  recordedAt: string;
}): {
  nextClaims: ProfileMemoryGraphClaimRecord[];
  changed: boolean;
} {
  let changed = false;
  const nextClaims = input.claims.map((claim) => {
    const nextClaim = normalizeProfileMemoryGraphClaimMetadataRecord({
      claim,
      recordedAt: input.recordedAt
    });
    if (nextClaim !== claim) {
      changed = true;
    }
    return nextClaim;
  });

  return {
    nextClaims,
    changed
  };
}

/**
 * Repairs event metadata, semantic identity, and bounded event text so blank or padded persisted
 * strings do not survive as canonical values.
 *
 * @param input - Canonical events plus one deterministic fallback timestamp.
 * @returns Repaired events and whether any metadata changed.
 */
export function normalizeProfileMemoryGraphEventMetadata(input: {
  events: readonly ProfileMemoryGraphEventRecord[];
  recordedAt: string;
}): {
  nextEvents: ProfileMemoryGraphEventRecord[];
  changed: boolean;
} {
  let changed = false;
  const nextEvents = input.events.map((event) => {
    const nextEvent = normalizeProfileMemoryGraphEventMetadataRecord({
      event,
      recordedAt: input.recordedAt
    });
    if (nextEvent !== event) {
      changed = true;
    }
    return nextEvent;
  });

  return {
    nextEvents,
    changed
  };
}

/**
 * Repairs one retained observation record when metadata or semantic identity is blank or padded.
 *
 * @param input - Candidate observation plus deterministic fallback timestamp.
 * @returns Original observation when metadata is already canonical, otherwise one repaired envelope.
 */
function normalizeProfileMemoryGraphObservationMetadataRecord(input: {
  observation: ProfileMemoryGraphObservationRecord;
  recordedAt: string;
}): ProfileMemoryGraphObservationRecord {
  const { payload } = input.observation;
  const nextStableRefId = normalizeOptionalMetadataString(payload.stableRefId);
  const nextFamily = normalizeOptionalSemanticIdentityString(payload.family);
  const nextNormalizedKey = normalizeOptionalSemanticIdentityString(payload.normalizedKey);
  const nextNormalizedValue = normalizeOptionalSemanticIdentityString(payload.normalizedValue);
  const nextSourceTaskId = normalizeOptionalMetadataString(payload.sourceTaskId);
  const nextSourceFingerprint = normalizeRequiredMetadataString(payload.sourceFingerprint) ??
    buildProfileMemoryGraphObservationMetadataFallbackSourceFingerprint(payload.observationId);

  if (
    nextStableRefId === payload.stableRefId &&
    nextFamily === payload.family &&
    nextNormalizedKey === payload.normalizedKey &&
    nextNormalizedValue === payload.normalizedValue &&
    nextSourceTaskId === payload.sourceTaskId &&
    nextSourceFingerprint === payload.sourceFingerprint
  ) {
    return input.observation;
  }

  return rebuildProfileMemoryGraphEnvelope({
    record: input.observation,
    schemaName: PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
    payload: {
      ...payload,
      stableRefId: nextStableRefId,
      family: nextFamily,
      normalizedKey: nextNormalizedKey,
      normalizedValue: nextNormalizedValue,
      sourceTaskId: nextSourceTaskId,
      sourceFingerprint: nextSourceFingerprint
    },
    fallbackCreatedAt: input.recordedAt
  });
}

/**
 * Repairs one retained claim record when metadata or semantic identity is blank or padded.
 *
 * @param input - Candidate claim plus deterministic fallback timestamp.
 * @returns Original claim when metadata is already canonical, otherwise one repaired envelope.
 */
function normalizeProfileMemoryGraphClaimMetadataRecord(input: {
  claim: ProfileMemoryGraphClaimRecord;
  recordedAt: string;
}): ProfileMemoryGraphClaimRecord {
  const { payload } = input.claim;
  const nextStableRefId = normalizeOptionalMetadataString(payload.stableRefId);
  const nextFamily = normalizeRequiredSemanticIdentityString(payload.family);
  const nextNormalizedKey = normalizeRequiredSemanticIdentityString(payload.normalizedKey);
  const nextNormalizedValue = normalizeOptionalSemanticIdentityString(payload.normalizedValue);
  const nextSourceTaskId = normalizeOptionalMetadataString(payload.sourceTaskId);
  const nextSourceFingerprint = normalizeRequiredMetadataString(payload.sourceFingerprint) ??
    buildProfileMemoryGraphClaimMetadataFallbackSourceFingerprint(payload.claimId);

  if (
    nextStableRefId === payload.stableRefId &&
    nextFamily === payload.family &&
    nextNormalizedKey === payload.normalizedKey &&
    nextNormalizedValue === payload.normalizedValue &&
    nextSourceTaskId === payload.sourceTaskId &&
    nextSourceFingerprint === payload.sourceFingerprint
  ) {
    return input.claim;
  }

  return rebuildProfileMemoryGraphEnvelope({
    record: input.claim,
    schemaName: PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
    payload: {
      ...payload,
      stableRefId: nextStableRefId,
      family: nextFamily,
      normalizedKey: nextNormalizedKey,
      normalizedValue: nextNormalizedValue,
      sourceTaskId: nextSourceTaskId,
      sourceFingerprint: nextSourceFingerprint
    },
    fallbackCreatedAt: input.recordedAt
  });
}

/**
 * Repairs one retained event record when metadata, semantic identity, or bounded event text is
 * blank or padded.
 *
 * @param input - Candidate event plus deterministic fallback timestamp.
 * @returns Original event when metadata is already canonical, otherwise one repaired envelope.
 */
function normalizeProfileMemoryGraphEventMetadataRecord(input: {
  event: ProfileMemoryGraphEventRecord;
  recordedAt: string;
}): ProfileMemoryGraphEventRecord {
  const { payload } = input.event;
  const nextStableRefId = normalizeOptionalMetadataString(payload.stableRefId);
  const nextFamily = normalizeOptionalSemanticIdentityString(payload.family);
  const nextTitle = normalizeRequiredEventText(payload.title, UNTITLED_EVENT_PLACEHOLDER);
  const nextSummary = normalizeRequiredEventText(
    payload.summary,
    EMPTY_EVENT_SUMMARY_PLACEHOLDER
  );
  const nextSourceTaskId = normalizeOptionalMetadataString(payload.sourceTaskId);
  const nextSourceFingerprint = normalizeRequiredMetadataString(payload.sourceFingerprint) ??
    buildProfileMemoryGraphEventMetadataFallbackSourceFingerprint(payload.eventId);

  if (
    nextStableRefId === payload.stableRefId &&
    nextFamily === payload.family &&
    nextTitle === payload.title &&
    nextSummary === payload.summary &&
    nextSourceTaskId === payload.sourceTaskId &&
    nextSourceFingerprint === payload.sourceFingerprint
  ) {
    return input.event;
  }

  return rebuildProfileMemoryGraphEnvelope({
    record: input.event,
    schemaName: PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME,
    payload: {
      ...payload,
      stableRefId: nextStableRefId,
      family: nextFamily,
      title: nextTitle,
      summary: nextSummary,
      sourceTaskId: nextSourceTaskId,
      sourceFingerprint: nextSourceFingerprint
    },
    fallbackCreatedAt: input.recordedAt
  });
}

/**
 * Builds one deterministic fallback source fingerprint for a retained observation with malformed
 * required provenance.
 *
 * @param observationId - Canonical observation identifier.
 * @returns Deterministic synthetic fingerprint.
 */
function buildProfileMemoryGraphObservationMetadataFallbackSourceFingerprint(
  observationId: string
): string {
  return `graph_observation_source_${sha256HexFromCanonicalJson({ observationId }).slice(0, 24)}`;
}

/**
 * Builds one deterministic fallback source fingerprint for a retained claim with malformed
 * required provenance.
 *
 * @param claimId - Canonical claim identifier.
 * @returns Deterministic synthetic fingerprint.
 */
function buildProfileMemoryGraphClaimMetadataFallbackSourceFingerprint(claimId: string): string {
  return `graph_claim_source_${sha256HexFromCanonicalJson({ claimId }).slice(0, 24)}`;
}

/**
 * Builds one deterministic fallback source fingerprint for a retained event with malformed
 * required provenance.
 *
 * @param eventId - Canonical event identifier.
 * @returns Deterministic synthetic fingerprint.
 */
function buildProfileMemoryGraphEventMetadataFallbackSourceFingerprint(eventId: string): string {
  return `graph_event_source_${sha256HexFromCanonicalJson({ eventId }).slice(0, 24)}`;
}

/**
 * Trims optional metadata strings and clears whitespace-only values fail-closed.
 *
 * @param value - Persisted optional metadata candidate.
 * @returns Trimmed string or `null` when the candidate is blank or malformed.
 */
function normalizeOptionalMetadataString(value: string | null): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Trims one required metadata string and clears whitespace-only values fail-closed.
 *
 * @param value - Required metadata candidate.
 * @returns Trimmed string or `null` when the candidate is blank or malformed.
 */
function normalizeRequiredMetadataString(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Trims one required non-redacted event text field and repairs blank payloads to bounded
 * placeholders.
 *
 * @param value - Required event-text candidate.
 * @param fallback - Deterministic placeholder when the candidate is blank or malformed.
 * @returns Trimmed canonical string or the bounded fallback.
 */
function normalizeRequiredEventText(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

/**
 * Trims one optional semantic-identity string and clears whitespace-only values fail-closed.
 *
 * @param value - Optional semantic-identity candidate.
 * @returns Trimmed canonical string or `null` when the candidate is blank or malformed.
 */
function normalizeOptionalSemanticIdentityString(value: string | null): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Trims one required semantic-identity string and repairs blank payloads to the fail-closed empty
 * string.
 *
 * @param value - Required semantic-identity candidate.
 * @returns Trimmed canonical string, or `""` when the candidate is blank after trimming.
 */
function normalizeRequiredSemanticIdentityString(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "";
}
