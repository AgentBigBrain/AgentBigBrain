/**
 * @fileoverview Deterministic observation-lane helpers for additive profile-memory graph state.
 */

import { sha256HexFromCanonicalJson } from "../normalizers/canonicalizationRules";
import { createSchemaEnvelopeV1 } from "../schemaEnvelope";
import type {
  ProfileMemoryGraphObservationRecord,
  ProfileMemoryGraphSourceTier,
  ProfileMemoryGraphTimeSource
} from "./profileMemoryGraphContracts";
import { PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME } from "./profileMemoryGraphContracts";
import {
  normalizeProfileMemoryGraphFactSource,
  normalizeProfileMemoryGraphFactSourceTaskId,
  rebuildProfileMemoryGraphEnvelope
} from "./profileMemoryGraphStateSupport";
import type { GovernedProfileFactCandidate } from "./profileMemoryTruthGovernanceContracts";

/**
 * Upserts deterministic observation records for all non-quarantined fact candidates in one batch.
 *
 * @param input - Existing observations plus governed fact decisions.
 * @returns Updated observation collection plus touched ids.
 */
export function upsertProfileMemoryGraphObservations(input: {
  existingObservations: readonly ProfileMemoryGraphObservationRecord[];
  factDecisions: readonly GovernedProfileFactCandidate[];
  sourceFingerprint: string;
  recordedAt: string;
}): {
  nextObservations: ProfileMemoryGraphObservationRecord[];
  touchedObservationIds: string[];
  changed: boolean;
} {
  const observationMap = new Map(
    input.existingObservations.map((observation) => [observation.payload.observationId, observation])
  );
  const touchedObservationIds: string[] = [];
  let changed = false;

  for (const entry of input.factDecisions) {
    const desiredObservation = buildProfileMemoryGraphObservationEnvelope({
      candidate: entry.candidate,
      decision: entry.decision,
      sourceFingerprint: input.sourceFingerprint,
      recordedAt: input.recordedAt
    });
    const observationId = desiredObservation.payload.observationId;
    const existingObservation = observationMap.get(observationId);
    const nextObservation = existingObservation === undefined
      ? desiredObservation
      : rebuildProfileMemoryGraphEnvelope({
        record: existingObservation,
        schemaName: PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
        payload: desiredObservation.payload,
        fallbackCreatedAt: input.recordedAt
      });
    if (existingObservation && graphObservationRecordsEqual(existingObservation, nextObservation)) {
      continue;
    }
    observationMap.set(observationId, nextObservation);
    if (!touchedObservationIds.includes(observationId)) {
      touchedObservationIds.push(observationId);
    }
    changed = true;
  }

  return {
    nextObservations: [...observationMap.values()].sort(compareObservationRecords),
    touchedObservationIds,
    changed
  };
}

/**
 * Builds one deterministic graph observation envelope from one governed fact candidate.
 *
 * @param input - Governed fact candidate plus batch-level source fingerprint.
 * @returns Deterministic observation envelope.
 */
function buildProfileMemoryGraphObservationEnvelope(input: {
  candidate: GovernedProfileFactCandidate["candidate"];
  decision: GovernedProfileFactCandidate["decision"];
  sourceFingerprint: string;
  recordedAt: string;
}): ProfileMemoryGraphObservationRecord {
  const normalizedKey = input.candidate.key.trim().toLowerCase();
  const normalizedValue = normalizeComparableValue(input.candidate.value);
  const observedAt = safeIsoOrFallback(input.candidate.observedAt, input.recordedAt);
  const normalizedSource = normalizeProfileMemoryGraphFactSource(input.candidate.source);
  const observationId = buildProfileMemoryGraphObservationId({
    family: input.decision.family,
    normalizedKey,
    normalizedValue,
    source: normalizedSource,
    observedAt,
    sourceFingerprint: input.sourceFingerprint
  });
  return createSchemaEnvelopeV1(
    PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
    {
      observationId,
      stableRefId: null,
      family: input.decision.family,
      normalizedKey,
      normalizedValue,
      redactionState: "not_requested",
      redactedAt: null,
      sensitive: input.candidate.sensitive,
      sourceTaskId: normalizeProfileMemoryGraphFactSourceTaskId(input.candidate.sourceTaskId),
      sourceFingerprint: input.sourceFingerprint,
      sourceTier: toGraphSourceTier(input.decision.evidenceClass),
      assertedAt: observedAt,
      observedAt,
      timePrecision: "instant",
      timeSource: toGraphTimeSource(input.decision.evidenceClass),
      entityRefIds: []
    },
    observedAt
  );
}

/**
 * Builds one deterministic observation id from the stable observation identity payload.
 *
 * @param payload - Stable observation identity payload.
 * @returns Deterministic observation id.
 */
function buildProfileMemoryGraphObservationId(payload: {
  family: string;
  normalizedKey: string;
  normalizedValue: string;
  source: string;
  observedAt: string;
  sourceFingerprint: string;
}): string {
  return `observation_${sha256HexFromCanonicalJson(payload).slice(0, 24)}`;
}

/**
 * Maps one governance evidence class onto the bounded graph-backed source tier.
 *
 * @param evidenceClass - Governance evidence class.
 * @returns Graph-backed source tier.
 */
function toGraphSourceTier(
  evidenceClass: GovernedProfileFactCandidate["decision"]["evidenceClass"]
): ProfileMemoryGraphSourceTier {
  switch (evidenceClass) {
    case "validated_structured_candidate":
      return "validated_structured_candidate";
    case "reconciliation_or_projection":
      return "reconciliation_or_projection";
    case "assistant_inference":
      return "assistant_inference";
    case "user_explicit_fact":
    case "user_hint_or_context":
    case "user_explicit_episode":
      return "explicit_user_statement";
  }
}

/**
 * Maps one governance evidence class onto the bounded graph-backed time source.
 *
 * @param evidenceClass - Governance evidence class.
 * @returns Graph-backed time source.
 */
function toGraphTimeSource(
  evidenceClass: GovernedProfileFactCandidate["decision"]["evidenceClass"]
): ProfileMemoryGraphTimeSource {
  switch (evidenceClass) {
    case "validated_structured_candidate":
      return "asserted_at";
    case "reconciliation_or_projection":
      return "system_generated";
    case "assistant_inference":
      return "inferred";
    case "user_explicit_fact":
    case "user_hint_or_context":
    case "user_explicit_episode":
      return "user_stated";
  }
}

/**
 * Normalizes one value for graph identity comparisons.
 *
 * @param value - Raw comparable value.
 * @returns Trimmed comparison-safe value.
 */
function normalizeComparableValue(value: string): string {
  return value.trim();
}

/**
 * Compares two observation records for deterministic persistence ordering.
 *
 * @param left - Left observation record.
 * @param right - Right observation record.
 * @returns Stable ordering result.
 */
function compareObservationRecords(
  left: ProfileMemoryGraphObservationRecord,
  right: ProfileMemoryGraphObservationRecord
): number {
  if (left.payload.observedAt !== right.payload.observedAt) {
    return left.payload.observedAt.localeCompare(right.payload.observedAt);
  }
  return left.payload.observationId.localeCompare(right.payload.observationId);
}

/**
 * Compares two observation records for canonical equality without relying on object identity.
 *
 * @param left - Left observation record.
 * @param right - Right observation record.
 * @returns `true` when the records are equivalent.
 */
function graphObservationRecordsEqual(
  left: ProfileMemoryGraphObservationRecord,
  right: ProfileMemoryGraphObservationRecord
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Coerces one timestamp candidate to ISO format with a caller-supplied fallback.
 *
 * @param value - Unknown timestamp candidate.
 * @param fallback - Fallback ISO timestamp.
 * @returns Valid ISO timestamp string.
 */
function safeIsoOrFallback(value: unknown, fallback: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return Number.isFinite(Date.parse(trimmed))
    ? new Date(Date.parse(trimmed)).toISOString()
    : fallback;
}
