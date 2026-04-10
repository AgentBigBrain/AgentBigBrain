/**
 * @fileoverview Evidence projection, lifecycle, and ranking helpers for bounded temporal queries.
 */

import {
  type ProfileMemoryGraphClaimRecord,
  type ProfileMemoryGraphEventRecord,
  type ProfileMemoryGraphObservationRecord
} from "./profileMemoryGraphContracts";
import {
  DEFAULT_PROFILE_MEMORY_TEMPORAL_QUERY_CAPS,
  type ProfileMemoryTemporalClaimEvidence,
  type ProfileMemoryTemporalEventEvidence,
  type ProfileMemoryTemporalLifecycleBuckets,
  type ProfileMemoryTemporalObservationEvidence,
  type ProfileMemoryTemporalQueryCaps
} from "./profileMemoryTemporalQueryContracts";

const TEMPORAL_RETRIEVAL_SOURCE_TIER_WEIGHT = {
  explicit_user_statement: 4,
  validated_structured_candidate: 3,
  reconciliation_or_projection: 2,
  assistant_inference: 1
} as const;

type RetrievalRankTuple = readonly [number, number, number, number, string];

/**
 * Normalizes partial temporal caps into the bounded canonical cap set.
 *
 * **Why it exists:**
 * Retrieval callers can pass partial overrides, but the downstream selection logic expects every
 * cap to exist and to stay at or above one.
 *
 * **What it talks to:**
 * - Uses `DEFAULT_PROFILE_MEMORY_TEMPORAL_QUERY_CAPS` (import `DEFAULT_PROFILE_MEMORY_TEMPORAL_QUERY_CAPS`) from `./profileMemoryTemporalQueryContracts`.
 *
 * @param caps - Optional partial cap overrides.
 * @returns Complete bounded cap configuration.
 */
export function normalizeTemporalCaps(
  caps: Partial<ProfileMemoryTemporalQueryCaps> | undefined
): ProfileMemoryTemporalQueryCaps {
  return {
    maxFocusEntities: Math.max(1, caps?.maxFocusEntities ?? DEFAULT_PROFILE_MEMORY_TEMPORAL_QUERY_CAPS.maxFocusEntities),
    maxClaimFamiliesPerFocusEntity: Math.max(1, caps?.maxClaimFamiliesPerFocusEntity ?? DEFAULT_PROFILE_MEMORY_TEMPORAL_QUERY_CAPS.maxClaimFamiliesPerFocusEntity),
    maxCandidateClaimsPerFamily: Math.max(1, caps?.maxCandidateClaimsPerFamily ?? DEFAULT_PROFILE_MEMORY_TEMPORAL_QUERY_CAPS.maxCandidateClaimsPerFamily),
    maxEventsPerFocusEntity: Math.max(1, caps?.maxEventsPerFocusEntity ?? DEFAULT_PROFILE_MEMORY_TEMPORAL_QUERY_CAPS.maxEventsPerFocusEntity),
    maxObservationsPerCluster: Math.max(1, caps?.maxObservationsPerCluster ?? DEFAULT_PROFILE_MEMORY_TEMPORAL_QUERY_CAPS.maxObservationsPerCluster),
    maxContradictionNotes: Math.max(1, caps?.maxContradictionNotes ?? DEFAULT_PROFILE_MEMORY_TEMPORAL_QUERY_CAPS.maxContradictionNotes)
  };
}

/**
 * Projects one graph observation onto the canonical temporal evidence contract.
 *
 * **Why it exists:**
 * Retrieval needs a stable public evidence shape without exposing the persisted graph envelope.
 *
 * **What it talks to:**
 * - Uses `ProfileMemoryGraphObservationRecord` (import `ProfileMemoryGraphObservationRecord`) from `./profileMemoryGraphContracts`.
 *
 * @param observation - Persisted graph observation record.
 * @returns Public temporal observation evidence.
 */
export function toObservationEvidence(
  observation: ProfileMemoryGraphObservationRecord
): ProfileMemoryTemporalObservationEvidence {
  return {
    observationId: observation.payload.observationId,
    stableRefId: observation.payload.stableRefId,
    family: observation.payload.family,
    normalizedKey: observation.payload.normalizedKey,
    normalizedValue: observation.payload.normalizedValue,
    assertedAt: observation.payload.assertedAt,
    observedAt: observation.payload.observedAt,
    sourceTier: observation.payload.sourceTier,
    entityRefIds: [...observation.payload.entityRefIds]
  };
}

/**
 * Projects one graph claim plus its bounded supporting observation ids onto temporal evidence.
 *
 * **Why it exists:**
 * Claim retrieval and synthesis must operate on a stable contract that preserves lineage without
 * leaking graph-specific record metadata.
 *
 * **What it talks to:**
 * - Uses `ProfileMemoryGraphClaimRecord` (import `ProfileMemoryGraphClaimRecord`) from `./profileMemoryGraphContracts`.
 *
 * @param claim - Persisted graph claim record.
 * @param supportingObservationIds - Selected supporting observation ids that survived bounding.
 * @returns Public temporal claim evidence.
 */
export function toClaimEvidence(
  claim: ProfileMemoryGraphClaimRecord,
  supportingObservationIds: readonly string[]
): ProfileMemoryTemporalClaimEvidence {
  return {
    claimId: claim.payload.claimId,
    stableRefId: claim.payload.stableRefId,
    family: claim.payload.family as ProfileMemoryTemporalClaimEvidence["family"],
    normalizedKey: claim.payload.normalizedKey,
    normalizedValue: claim.payload.normalizedValue,
    assertedAt: claim.payload.assertedAt,
    validFrom: claim.payload.validFrom,
    validTo: claim.payload.validTo,
    endedAt: claim.payload.endedAt,
    active: claim.payload.active,
    sourceTier: claim.payload.sourceTier,
    entityRefIds: [...claim.payload.entityRefIds],
    supportingObservationIds
  };
}

/**
 * Projects one graph event plus its bounded supporting observation ids onto temporal evidence.
 *
 * **Why it exists:**
 * Event retrieval needs the same stable contract discipline as claims so synthesis can stay
 * deterministic across current and historical lanes.
 *
 * **What it talks to:**
 * - Uses `ProfileMemoryGraphEventRecord` (import `ProfileMemoryGraphEventRecord`) from `./profileMemoryGraphContracts`.
 *
 * @param event - Persisted graph event record.
 * @param supportingObservationIds - Selected supporting observation ids that survived bounding.
 * @returns Public temporal event evidence.
 */
export function toEventEvidence(
  event: ProfileMemoryGraphEventRecord,
  supportingObservationIds: readonly string[]
): ProfileMemoryTemporalEventEvidence {
  return {
    eventId: event.payload.eventId,
    stableRefId: event.payload.stableRefId,
    family: event.payload.family,
    title: event.payload.title,
    summary: event.payload.summary,
    assertedAt: event.payload.assertedAt,
    observedAt: event.payload.observedAt,
    validFrom: event.payload.validFrom,
    validTo: event.payload.validTo,
    sourceTier: event.payload.sourceTier,
    entityRefIds: [...event.payload.entityRefIds],
    supportingObservationIds
  };
}

/**
 * Converts lifecycle bucket ids into the canonical bounded lifecycle summary shape.
 *
 * **Why it exists:**
 * Retrieval needs one shared overflow-note format for both claims and events.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param ids - Lifecycle bucket ids collected during selection.
 * @param cap - Per-bucket cap used for overflow reporting.
 * @returns Canonical lifecycle bucket summary.
 */
export function toLifecycleBuckets(
  ids: { current: readonly string[]; historical: readonly string[]; ended: readonly string[] },
  cap: number
): ProfileMemoryTemporalLifecycleBuckets {
  const totalCount = ids.current.length + ids.historical.length + ids.ended.length;
  return {
    current: ids.current.slice(0, cap),
    historical: ids.historical.slice(0, cap),
    ended: ids.ended.slice(0, cap),
    overflowNote: totalCount > cap ? `bounded_overflow:${totalCount - cap} additional records omitted` : null
  };
}

/**
 * Parses one ISO timestamp into epoch milliseconds and fails closed on malformed input.
 *
 * **Why it exists:**
 * Retrieval ordering and as-of filtering need one deterministic malformed-time posture.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Optional ISO timestamp.
 * @returns Parsed epoch milliseconds, or `null` when parsing fails.
 */
export function getIsoTimeMs(value: string | null | undefined): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Evaluates whether one observed record is visible under the current observed-time boundary.
 *
 * **Why it exists:**
 * Temporal retrieval must hide future-observed records without duplicating the same fail-closed
 * boundary check across claims, events, and observations.
 *
 * **What it talks to:**
 * - Uses `getIsoTimeMs` (import `getIsoTimeMs`) from `./profileMemoryTemporalQueryEvidenceSupport`.
 *
 * @param observedAt - Record observed timestamp.
 * @param asOfObservedTime - Optional observed-time boundary.
 * @returns `true` when the record remains visible at the boundary.
 */
export function isRecordVisibleAtObservedBoundary(
  observedAt: string,
  asOfObservedTime: string | null
): boolean {
  if (!asOfObservedTime) {
    return true;
  }
  const observedMs = getIsoTimeMs(observedAt);
  const boundaryMs = getIsoTimeMs(asOfObservedTime);
  return observedMs !== null && boundaryMs !== null && observedMs <= boundaryMs;
}

/**
 * Classifies one claim into current, historical, or ended lifecycle state.
 *
 * **Why it exists:**
 * Claim synthesis needs one shared lifecycle rule so as-of filters and active flags do not drift.
 *
 * **What it talks to:**
 * - Uses `getIsoTimeMs` (import `getIsoTimeMs`) from `./profileMemoryTemporalQueryEvidenceSupport`.
 * - Uses `ProfileMemoryGraphClaimRecord` (import `ProfileMemoryGraphClaimRecord`) from `./profileMemoryGraphContracts`.
 *
 * @param claim - Claim record under classification.
 * @param asOfValidTime - Optional valid-time boundary.
 * @returns Canonical lifecycle lane for the claim.
 */
export function classifyClaimLifecycle(
  claim: ProfileMemoryGraphClaimRecord,
  asOfValidTime: string | null
): "current" | "historical" | "ended" {
  const boundaryMs = getIsoTimeMs(asOfValidTime);
  const validFromMs = getIsoTimeMs(claim.payload.validFrom);
  const validToMs = getIsoTimeMs(claim.payload.validTo);
  const endedAtMs = getIsoTimeMs(claim.payload.endedAt);
  if (boundaryMs !== null) {
    if (validFromMs !== null && validFromMs > boundaryMs) {
      return "historical";
    }
    if ((validToMs !== null && validToMs <= boundaryMs) || (endedAtMs !== null && endedAtMs <= boundaryMs)) {
      return "ended";
    }
  }
  if (!claim.payload.active || claim.payload.redactionState === "redacted") {
    return "ended";
  }
  return claim.payload.endedAt || claim.payload.validTo ? "historical" : "current";
}

/**
 * Classifies one event into current, historical, or ended lifecycle state.
 *
 * **Why it exists:**
 * Event synthesis needs the same stable as-of semantics as claims while respecting event-specific
 * valid-to and redaction fields.
 *
 * **What it talks to:**
 * - Uses `getIsoTimeMs` (import `getIsoTimeMs`) from `./profileMemoryTemporalQueryEvidenceSupport`.
 * - Uses `ProfileMemoryGraphEventRecord` (import `ProfileMemoryGraphEventRecord`) from `./profileMemoryGraphContracts`.
 *
 * @param event - Event record under classification.
 * @param asOfValidTime - Optional valid-time boundary.
 * @returns Canonical lifecycle lane for the event.
 */
export function classifyEventLifecycle(
  event: ProfileMemoryGraphEventRecord,
  asOfValidTime: string | null
): "current" | "historical" | "ended" {
  const boundaryMs = getIsoTimeMs(asOfValidTime);
  const validFromMs = getIsoTimeMs(event.payload.validFrom);
  const validToMs = getIsoTimeMs(event.payload.validTo);
  if (boundaryMs !== null) {
    if (validFromMs !== null && validFromMs > boundaryMs) {
      return "historical";
    }
    if (validToMs !== null && validToMs <= boundaryMs) {
      return "ended";
    }
  }
  if (event.payload.redactionState === "redacted") {
    return "ended";
  }
  return event.payload.validTo ? "historical" : "current";
}

/**
 * Builds a deterministic ranking tuple for claim retrieval.
 *
 * **Why it exists:**
 * Bounded retrieval must keep higher-authority active claims inside the slice before recency
 * churn, while still allowing corroboration depth and recency to act as bounded salience signals
 * among otherwise-eligible candidates.
 *
 * **What it talks to:**
 * - Uses `getIsoTimeMs` (import `getIsoTimeMs`) from `./profileMemoryTemporalQueryEvidenceSupport`.
 * - Uses `ProfileMemoryGraphClaimRecord` (import `ProfileMemoryGraphClaimRecord`) from `./profileMemoryGraphContracts`.
 *
 * @param claim - Claim record under ranking.
 * @returns Stable ranking tuple.
 */
export function scoreClaimForRetrieval(claim: ProfileMemoryGraphClaimRecord): RetrievalRankTuple {
  return [
    claim.payload.active ? 1 : 0,
    TEMPORAL_RETRIEVAL_SOURCE_TIER_WEIGHT[claim.payload.sourceTier],
    claim.payload.derivedFromObservationIds.length,
    getIsoTimeMs(claim.payload.validFrom ?? claim.payload.assertedAt) ?? 0,
    claim.payload.claimId
  ];
}

/**
 * Builds a deterministic ranking tuple for event retrieval.
 *
 * **Why it exists:**
 * Event selection needs the same authority-first bounded posture as claims, with observation depth
 * and recency acting only as deterministic salience among still-eligible candidates.
 *
 * **What it talks to:**
 * - Uses `getIsoTimeMs` (import `getIsoTimeMs`) from `./profileMemoryTemporalQueryEvidenceSupport`.
 * - Uses `ProfileMemoryGraphEventRecord` (import `ProfileMemoryGraphEventRecord`) from `./profileMemoryGraphContracts`.
 *
 * @param event - Event record under ranking.
 * @returns Stable ranking tuple.
 */
export function scoreEventForRetrieval(event: ProfileMemoryGraphEventRecord): RetrievalRankTuple {
  return [
    event.payload.validTo === null ? 1 : 0,
    TEMPORAL_RETRIEVAL_SOURCE_TIER_WEIGHT[event.payload.sourceTier],
    event.payload.derivedFromObservationIds.length,
    getIsoTimeMs(event.payload.observedAt) ?? 0,
    event.payload.eventId
  ];
}

/**
 * Compares two deterministic ranking tuples in descending score order.
 *
 * **Why it exists:**
 * Claims and events share the same tuple comparison rule, so this helper keeps the ordering logic
 * centralized and auditable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param left - Left ranking tuple.
 * @param right - Right ranking tuple.
 * @returns Negative when the left tuple should sort first.
 */
export function compareRankedTuple(
  left: RetrievalRankTuple,
  right: RetrievalRankTuple
): number {
  if (left[0] !== right[0]) {
    return right[0] - left[0];
  }
  if (left[1] !== right[1]) {
    return right[1] - left[1];
  }
  if (left[2] !== right[2]) {
    return right[2] - left[2];
  }
  if (left[3] !== right[3]) {
    return right[3] - left[3];
  }
  return left[4].localeCompare(right[4]);
}

/**
 * Selects the bounded supporting observations for one claim or event and records degradations.
 *
 * **Why it exists:**
 * Both claim and event retrieval need the same missing-observation and overflow handling.
 *
 * **What it talks to:**
 * - Uses `ProfileMemoryGraphObservationRecord` (import `ProfileMemoryGraphObservationRecord`) from `./profileMemoryGraphContracts`.
 *
 * @param observationIds - Candidate supporting observation ids.
 * @param observationsById - Loaded observations indexed by observation id.
 * @param caps - Active retrieval caps.
 * @param degradedNotes - Mutable degraded-note accumulator for the current focus entity.
 * @returns Selected supporting observation ids plus loaded records.
 */
export function buildSupportingObservationSelection(
  observationIds: readonly string[],
  observationsById: ReadonlyMap<string, ProfileMemoryGraphObservationRecord>,
  caps: ProfileMemoryTemporalQueryCaps,
  degradedNotes: string[]
): {
  supportingObservationIds: readonly string[];
  selectedObservations: readonly ProfileMemoryGraphObservationRecord[];
} {
  const selected: ProfileMemoryGraphObservationRecord[] = [];
  const selectedIds: string[] = [];
  for (const observationId of observationIds.slice(0, caps.maxObservationsPerCluster)) {
    const observation = observationsById.get(observationId);
    if (!observation) {
      degradedNotes.push(`missing_supporting_observation:${observationId}`);
      continue;
    }
    selected.push(observation);
    selectedIds.push(observationId);
  }
  if (observationIds.length > caps.maxObservationsPerCluster) {
    degradedNotes.push(`bounded_overflow:${observationIds.length - caps.maxObservationsPerCluster} supporting observations omitted`);
  }
  return {
    supportingObservationIds: selectedIds,
    selectedObservations: selected
  };
}
