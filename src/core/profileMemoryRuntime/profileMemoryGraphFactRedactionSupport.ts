/**
 * @fileoverview Bounded fact-redaction helpers for additive profile-memory graph state.
 */

import type { ProfileFactRecord } from "../profileMemory";
import type {
  ProfileMemoryGraphClaimRecord,
  ProfileMemoryGraphObservationRecord
} from "./profileMemoryGraphContracts";
import {
  PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
  PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME
} from "./profileMemoryGraphContracts";
import { rebuildProfileMemoryGraphEnvelope } from "./profileMemoryGraphStateSupport";

/**
 * Redacts raw fact values from additive graph observations and claims while retaining bounded
 * audit markers for explicit fact-forget mutations.
 *
 * @param input - Existing graph observations and claims plus the facts targeted for deletion.
 * @returns Updated graph records plus touched identifiers.
 */
export function redactProfileMemoryGraphFacts(input: {
  existingObservations: readonly ProfileMemoryGraphObservationRecord[];
  existingClaims: readonly ProfileMemoryGraphClaimRecord[];
  redactedFacts: readonly ProfileFactRecord[];
  sourceTaskId: string | null;
  sourceFingerprint: string;
  recordedAt: string;
}): {
  nextObservations: ProfileMemoryGraphObservationRecord[];
  nextClaims: ProfileMemoryGraphClaimRecord[];
  touchedObservationIds: string[];
  touchedClaimIds: string[];
  changed: boolean;
} {
  if (input.redactedFacts.length === 0) {
    return {
      nextObservations: [...input.existingObservations],
      nextClaims: [...input.existingClaims],
      touchedObservationIds: [],
      touchedClaimIds: [],
      changed: false
    };
  }

  const targetedFactValues = collectTargetedFactValues(input.redactedFacts);
  const targetedFactIds = collectTargetedFactIds(input.redactedFacts);
  const targetedFactIdsByValueToken = collectTargetedFactIdsByValueToken(input.redactedFacts);
  const observationsById = new Map(input.existingObservations.map((observation) =>
    [observation.payload.observationId, observation] as const));
  const targetedObservationIdsByClaimId = collectTargetedObservationIdsByClaimId({
    claims: input.existingClaims,
    observationsById,
    targetedFactValues,
    targetedFactIds
  });
  const targetedObservationIds = new Set([...targetedObservationIdsByClaimId.values()]
    .flatMap((observationIds) => observationIds));
  const observationMap = new Map(
    input.existingObservations.map((observation) => [observation.payload.observationId, observation])
  );
  const claimMap = new Map(input.existingClaims.map((claim) => [claim.payload.claimId, claim]));
  const touchedObservationIds = new Set<string>();
  const touchedClaimIds = new Set<string>();
  let changed = false;

  for (const observation of input.existingObservations) {
    if (
      !matchesRedactedFactObservationTarget({
        targetedFactValues,
        targetedObservationIds,
        observation
      })
    ) {
      continue;
    }
    const nextObservationPayload = {
      ...observation.payload,
      stableRefId: null,
      normalizedValue: null,
      redactionState: "redacted" as const,
      redactedAt: input.recordedAt,
      sensitive: true,
      sourceTaskId: input.sourceTaskId,
      sourceFingerprint: input.sourceFingerprint,
      entityRefIds: []
    };
    const nextObservation = rebuildProfileMemoryGraphEnvelope({
        record: observation,
        schemaName: PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
        payload: nextObservationPayload,
        fallbackCreatedAt: input.recordedAt
      });
    if (graphRecordEquals(observation, nextObservation)) {
      continue;
    }
    observationMap.set(observation.payload.observationId, nextObservation);
    touchedObservationIds.add(observation.payload.observationId);
    changed = true;
  }

  for (const claim of input.existingClaims) {
    if (
      !matchesRedactedFactClaimTarget({
        targetedFactValues,
        targetedFactIds,
        claim
      })
    ) {
      continue;
    }
    const nextClaimPayload = {
      ...claim.payload,
      stableRefId: null,
      normalizedValue: null,
      redactionState: "redacted" as const,
      redactedAt: input.recordedAt,
      sensitive: true,
      sourceTaskId: input.sourceTaskId,
      sourceFingerprint: input.sourceFingerprint,
      active: false,
      validTo: claim.payload.validTo ?? input.recordedAt,
      endedAt: claim.payload.endedAt ?? input.recordedAt,
      derivedFromObservationIds: [...(targetedObservationIdsByClaimId.get(claim.payload.claimId) ?? [])],
      projectionSourceIds: selectRedactedClaimProjectionSourceIds({
        claim,
        targetedFactIds,
        targetedFactIdsByValueToken
      }),
      entityRefIds: []
    };
    const nextClaim = rebuildProfileMemoryGraphEnvelope({
        record: claim,
        schemaName: PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
        payload: nextClaimPayload,
        fallbackCreatedAt: input.recordedAt
      });
    if (graphRecordEquals(claim, nextClaim)) {
      continue;
    }
    claimMap.set(claim.payload.claimId, nextClaim);
    touchedClaimIds.add(claim.payload.claimId);
    changed = true;
  }

  return {
    nextObservations: [...observationMap.values()].sort(compareObservationRecords),
    nextClaims: [...claimMap.values()].sort(compareClaimRecords),
    touchedObservationIds: [...touchedObservationIds].sort((left, right) => left.localeCompare(right)),
    touchedClaimIds: [...touchedClaimIds].sort((left, right) => left.localeCompare(right)),
    changed
  };
}

/**
 * Collects canonical fact key/value pairs targeted for redaction.
 *
 * @param facts - Flat facts explicitly deleted by the user.
 * @returns Stable targeted key/value tokens.
 */
function collectTargetedFactValues(facts: readonly ProfileFactRecord[]): ReadonlySet<string> {
  return new Set(
    facts.map((fact) => buildRedactedFactValueToken(fact.key, fact.value))
  );
}

/**
 * Collects canonical fact ids explicitly targeted for redaction.
 *
 * @param facts - Flat facts explicitly deleted by the user.
 * @returns Stable targeted fact ids.
 */
function collectTargetedFactIds(facts: readonly ProfileFactRecord[]): ReadonlySet<string> {
  return new Set(facts.map((fact) => fact.id));
}

/**
 * Groups targeted fact ids by their canonical key/value identity.
 *
 * **Why it exists:**
 * First-time fact forget can target a still-non-redacted claim through semantic identity alone, but
 * repeat-forget repair later needs deterministic surviving fact ids on the redacted claim payload.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param facts - Flat facts explicitly deleted by the user.
 * @returns Canonical fact ids grouped by stable redaction token.
 */
function collectTargetedFactIdsByValueToken(
  facts: readonly ProfileFactRecord[]
): ReadonlyMap<string, readonly string[]> {
  const idsByValueToken = new Map<string, string[]>();
  for (const fact of facts) {
    const valueToken = buildRedactedFactValueToken(fact.key, fact.value);
    const existingIds = idsByValueToken.get(valueToken) ?? [];
    existingIds.push(fact.id);
    idsByValueToken.set(valueToken, existingIds);
  }
  return new Map(
    [...idsByValueToken.entries()].map(([valueToken, ids]) => [valueToken, sortUniqueStrings(ids)])
  );
}

/**
 * Collects retained observation ids that still qualify as deleted-fact support on targeted claims.
 *
 * @param input - Existing claims, observations, and targeted redaction identities.
 * @returns Canonical deleted-fact-support observation ids grouped by targeted claim id.
 */
function collectTargetedObservationIdsByClaimId(input: {
  claims: readonly ProfileMemoryGraphClaimRecord[];
  observationsById: ReadonlyMap<string, ProfileMemoryGraphObservationRecord>;
  targetedFactValues: ReadonlySet<string>;
  targetedFactIds: ReadonlySet<string>;
}): ReadonlyMap<string, readonly string[]> {
  const observationIdsByClaimId = new Map<string, readonly string[]>();
  for (const claim of input.claims) {
    if (
      !matchesRedactedFactClaimTarget({
        targetedFactValues: input.targetedFactValues,
        targetedFactIds: input.targetedFactIds,
        claim
      })
    ) {
      continue;
    }
    observationIdsByClaimId.set(
      claim.payload.claimId,
      sortUniqueStrings(
        claim.payload.derivedFromObservationIds.filter((observationId) => {
          const observation = input.observationsById.get(observationId);
          return observation !== undefined && matchesRedactedFactClaimObservationTarget({
            claim,
            observation,
            targetedFactValues: input.targetedFactValues,
            targetedFactIds: input.targetedFactIds
          });
        })
      )
    );
  }
  return observationIdsByClaimId;
}

/**
 * Evaluates whether one retained observation should participate in explicit fact-forget repair.
 *
 * @param input - Targeted redaction identities plus one observation record.
 * @returns `true` when the observation should be rewritten into redacted audit state.
 */
function matchesRedactedFactObservationTarget(input: {
  targetedFactValues: ReadonlySet<string>;
  targetedObservationIds: ReadonlySet<string>;
  observation: ProfileMemoryGraphObservationRecord;
}): boolean {
  return matchesRedactedFactValue(
    input.targetedFactValues,
    input.observation.payload.normalizedKey,
    input.observation.payload.normalizedValue
  ) || input.targetedObservationIds.has(input.observation.payload.observationId);
}

/**
 * Evaluates whether one claim-lineage observation still qualifies as deleted-fact support during
 * explicit fact-forget repair.
 *
 * @param input - Targeted claim plus one surviving observation candidate.
 * @returns `true` when the observation should stay on the deleted-fact support lane.
 */
function matchesRedactedFactClaimObservationTarget(input: {
  claim: ProfileMemoryGraphClaimRecord;
  observation: ProfileMemoryGraphObservationRecord;
  targetedFactValues: ReadonlySet<string>;
  targetedFactIds: ReadonlySet<string>;
}): boolean {
  if (
    matchesRedactedFactValue(
      input.targetedFactValues,
      input.observation.payload.normalizedKey,
      input.observation.payload.normalizedValue
    )
  ) {
    return true;
  }
  return (
    input.observation.payload.redactionState === "redacted" &&
    input.claim.payload.projectionSourceIds.some((sourceId) => input.targetedFactIds.has(sourceId)) &&
    input.observation.payload.family === input.claim.payload.family &&
    input.observation.payload.normalizedKey === input.claim.payload.normalizedKey
  );
}

/**
 * Evaluates whether one retained claim should participate in explicit fact-forget repair.
 *
 * @param input - Targeted redaction identities plus one claim record.
 * @returns `true` when the claim should be rewritten into redacted audit state.
 */
function matchesRedactedFactClaimTarget(input: {
  targetedFactValues: ReadonlySet<string>;
  targetedFactIds: ReadonlySet<string>;
  claim: ProfileMemoryGraphClaimRecord;
}): boolean {
  return matchesRedactedFactValue(
    input.targetedFactValues,
    input.claim.payload.normalizedKey,
    input.claim.payload.normalizedValue
  ) || input.claim.payload.projectionSourceIds.some((sourceId) => input.targetedFactIds.has(sourceId));
}

/**
 * Selects the canonical retained fact lineage that one redacted claim should carry after forget.
 *
 * **Why it exists:**
 * Fact-backed claims are supposed to keep only the deleted fact ids that actually justify the
 * retained redacted audit marker, instead of preserving stray retained lineage from malformed state.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param input - One claim plus the canonical fact ids targeted by the forget mutation.
 * @returns Sorted canonical fact ids that should remain on the redacted claim.
 */
function selectRedactedClaimProjectionSourceIds(input: {
  claim: ProfileMemoryGraphClaimRecord;
  targetedFactIds: ReadonlySet<string>;
  targetedFactIdsByValueToken: ReadonlyMap<string, readonly string[]>;
}): string[] {
  const targetedRetainedIds = sortUniqueStrings(
    input.claim.payload.projectionSourceIds.filter((sourceId) => input.targetedFactIds.has(sourceId))
  );
  if (targetedRetainedIds.length > 0) {
    return targetedRetainedIds;
  }
  if (
    typeof input.claim.payload.normalizedKey === "string" &&
    typeof input.claim.payload.normalizedValue === "string"
  ) {
    return [
      ...(input.targetedFactIdsByValueToken.get(
        buildRedactedFactValueToken(
          input.claim.payload.normalizedKey,
          input.claim.payload.normalizedValue
        )
      ) ?? [])
    ];
  }
  return [];
}

/**
 * Evaluates whether one graph record still carries a fact value targeted for redaction.
 *
 * @param targetedFactValues - Canonical key/value tokens targeted for deletion.
 * @param normalizedKey - Record normalized key.
 * @param normalizedValue - Record normalized value.
 * @returns `true` when the record still carries the deleted value.
 */
function matchesRedactedFactValue(
  targetedFactValues: ReadonlySet<string>,
  normalizedKey: string | null,
  normalizedValue: string | null
): boolean {
  return typeof normalizedKey === "string" &&
    typeof normalizedValue === "string" &&
    targetedFactValues.has(buildRedactedFactValueToken(normalizedKey, normalizedValue));
}

/**
 * Builds one stable comparison token for targeted fact redaction.
 *
 * @param key - Canonical fact key.
 * @param value - Canonical fact value.
 * @returns Stable comparison token.
 */
function buildRedactedFactValueToken(key: string, value: string): string {
  return `${key.trim().toLowerCase()}\u0000${value.trim()}`;
}

/**
 * Sorts and deduplicates one string list deterministically.
 *
 * **Why it exists:**
 * Redaction repair should keep canonical lineage order stable even when malformed retained state or
 * one mutation batch contributes duplicates.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param values - Candidate strings to sort and dedupe.
 * @returns Stable unique strings in lexicographic order.
 */
function sortUniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

/**
 * Orders graph observations deterministically for persistence.
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
 * Orders graph claims deterministically for persistence.
 *
 * @param left - Left claim record.
 * @param right - Right claim record.
 * @returns Stable ordering result.
 */
function compareClaimRecords(
  left: ProfileMemoryGraphClaimRecord,
  right: ProfileMemoryGraphClaimRecord
): number {
  if (left.payload.normalizedKey !== right.payload.normalizedKey) {
    return left.payload.normalizedKey.localeCompare(right.payload.normalizedKey);
  }
  return left.payload.claimId.localeCompare(right.payload.claimId);
}

/**
 * Compares rebuilt graph records against retained records without introducing ad hoc field checks.
 *
 * **Why it exists:**
 * Same-id forget repair needs one deterministic equality gate after envelope rebuilding so canonical
 * no-op repeats do not emit fake touched-record churn or empty journal activity.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param left - The retained graph record currently stored on the canonical id.
 * @param right - The rebuilt graph record candidate after bounded redaction repair.
 * @returns `true` when both graph records already match canonically and the repair should stay a no-op.
 */
function graphRecordEquals<TRecord>(left: TRecord, right: TRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
