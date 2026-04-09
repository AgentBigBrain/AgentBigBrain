/**
 * @fileoverview Deterministic current-claim helpers for additive profile-memory graph state.
 */

import { sha256HexFromCanonicalJson } from "../normalizers/canonicalizationRules";
import type { ProfileFactRecord } from "../profileMemory";
import { createSchemaEnvelopeV1 } from "../schemaEnvelope";
import type {
  ProfileMemoryGraphClaimRecord,
  ProfileMemoryGraphObservationRecord,
  ProfileMemoryGraphSourceTier,
  ProfileMemoryGraphTimeSource
} from "./profileMemoryGraphContracts";
import { PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME } from "./profileMemoryGraphContracts";
import { resolveProfileMemoryEffectiveSensitivity } from "./profileMemoryFactSensitivity";
import { inferGovernanceFamilyForNormalizedKey } from "./profileMemoryGovernanceFamilyInference";
import {
  normalizeProfileMemoryGraphFactKey,
  normalizeProfileMemoryGraphFactSourceTaskId,
  normalizeProfileMemoryGraphSourceRecordId,
  rebuildProfileMemoryGraphEnvelope,
  selectProfileMemoryGraphCurrentWinnerFactsByKey
} from "./profileMemoryGraphStateSupport";
import type { GovernedProfileFactCandidate } from "./profileMemoryTruthGovernanceContracts";

/**
 * Reconciles current winner claims for the keys touched by claim-authoritative facts in one batch.
 *
 * @param input - Existing claims, observations, canonical facts, and governed fact decisions.
 * @returns Updated claim collection plus touched ids.
 */
export function reconcileProfileMemoryCurrentClaims(input: {
  existingClaims: readonly ProfileMemoryGraphClaimRecord[];
  observations: readonly ProfileMemoryGraphObservationRecord[];
  facts: readonly ProfileFactRecord[];
  factDecisions: readonly GovernedProfileFactCandidate[];
  recordedAt: string;
}): {
  nextClaims: ProfileMemoryGraphClaimRecord[];
  touchedClaimIds: string[];
  changed: boolean;
} {
  const claimRelevantKeys = new Set(
    input.factDecisions
      .filter(
        (entry) =>
          entry.decision.action === "allow_current_state" ||
          entry.decision.action === "allow_end_state"
      )
      .map((entry) => entry.candidate.key.trim().toLowerCase())
  );
  if (claimRelevantKeys.size === 0) {
    return {
      nextClaims: [...input.existingClaims],
      touchedClaimIds: [],
      changed: false
    };
  }

  const claimMap = new Map(input.existingClaims.map((claim) => [claim.payload.claimId, claim]));
  const activeClaimsByKey = new Map<string, ProfileMemoryGraphClaimRecord[]>();
  for (const claim of input.existingClaims) {
    if (!claim.payload.active) {
      continue;
    }
    const bucket = activeClaimsByKey.get(claim.payload.normalizedKey) ?? [];
    bucket.push(claim);
    activeClaimsByKey.set(claim.payload.normalizedKey, bucket);
  }

  const touchedClaimIds = new Set<string>();
  let changed = false;
  const currentWinnerFacts = selectCurrentWinnerFactsByKey(input.facts, claimRelevantKeys);

  for (const key of claimRelevantKeys) {
    const winnerFact = currentWinnerFacts.get(key) ?? null;
    const desiredClaim = winnerFact
      ? buildProfileMemoryGraphClaimEnvelope({
          fact: winnerFact,
          observations: input.observations,
          recordedAt: input.recordedAt
        })
      : null;
    const desiredClaimId = desiredClaim?.payload.claimId ?? null;
    const existingActiveClaims = activeClaimsByKey.get(key) ?? [];

    for (const claim of existingActiveClaims) {
      if (claim.payload.claimId === desiredClaimId) {
        continue;
      }
      const closedClaim = closeProfileMemoryGraphClaimRecord(claim, input.recordedAt, desiredClaimId);
      if (!graphClaimRecordsEqual(closedClaim, claim)) {
        claimMap.set(closedClaim.payload.claimId, closedClaim);
        touchedClaimIds.add(closedClaim.payload.claimId);
        changed = true;
      }
    }

    if (!desiredClaim) {
      continue;
    }
    const existingClaim = claimMap.get(desiredClaim.payload.claimId);
    const nextClaim = existingClaim
      ? mergeProfileMemoryGraphClaimRecord(existingClaim, desiredClaim, input.recordedAt)
      : desiredClaim;
    if (!existingClaim || !graphClaimRecordsEqual(existingClaim, nextClaim)) {
      claimMap.set(nextClaim.payload.claimId, nextClaim);
      touchedClaimIds.add(nextClaim.payload.claimId);
      changed = true;
    }
  }

  return {
    nextClaims: [...claimMap.values()].sort(compareClaimRecords),
    touchedClaimIds: [...touchedClaimIds].sort((left, right) => left.localeCompare(right)),
    changed
  };
}

/**
 * Builds one deterministic current-claim envelope from the selected winner fact for one key.
 *
 * @param input - Winner fact plus supporting observations for that key/value.
 * @returns Deterministic claim envelope.
 */
function buildProfileMemoryGraphClaimEnvelope(input: {
  fact: ProfileFactRecord;
  observations: readonly ProfileMemoryGraphObservationRecord[];
  recordedAt: string;
}): ProfileMemoryGraphClaimRecord {
  const normalizedKey = normalizeProfileMemoryGraphFactKey(input.fact.key);
  const family = inferGovernanceFamilyForNormalizedKey(normalizedKey, input.fact.value);
  const normalizedValue = normalizeComparableValue(input.fact.value);
  const effectiveSensitive = resolveProfileMemoryEffectiveSensitivity(
    normalizedKey,
    input.fact.sensitive,
    family
  );
  const observationIds = input.observations
    .filter(
      (observation) =>
        observation.payload.normalizedKey === normalizedKey &&
        observation.payload.normalizedValue === normalizedValue
    )
    .map((observation) => observation.payload.observationId)
    .sort((left, right) => left.localeCompare(right));
  const claimId = buildProfileMemoryGraphClaimId({
    family,
    normalizedKey,
    normalizedValue
  });
  const claimSourceFingerprint = buildProfileMemoryGraphClaimSourceFingerprint({
    family,
    normalizedKey,
    normalizedValue
  });
  const projectionSourceId = normalizeProfileMemoryGraphSourceRecordId(input.fact.id);
  const assertedAt = safeIsoOrFallback(input.fact.observedAt, input.recordedAt);
  return createSchemaEnvelopeV1(
    PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
    {
      claimId,
      stableRefId: null,
      family,
      normalizedKey,
      normalizedValue,
      redactionState: "not_requested",
      redactedAt: null,
      sensitive: effectiveSensitive,
      sourceTaskId: normalizeProfileMemoryGraphFactSourceTaskId(input.fact.sourceTaskId),
      sourceFingerprint: claimSourceFingerprint,
      sourceTier: toGraphSourceTierFromSource(input.fact.source),
      assertedAt,
      validFrom: assertedAt,
      validTo: null,
      endedAt: null,
      endedByClaimId: null,
      timePrecision: "instant",
      timeSource: toGraphTimeSourceFromSource(input.fact.source),
      derivedFromObservationIds: observationIds,
      projectionSourceIds: projectionSourceId === null ? [] : [projectionSourceId],
      entityRefIds: [],
      active: true
    },
    input.recordedAt
  );
}

/**
 * Closes one previously active claim when a different current winner now owns the same key.
 *
 * @param claim - Existing active claim.
 * @param recordedAt - Timestamp for the closure mutation.
 * @param endedByClaimId - Successor claim id when known.
 * @returns Closed claim envelope.
 */
function closeProfileMemoryGraphClaimRecord(
  claim: ProfileMemoryGraphClaimRecord,
  recordedAt: string,
  endedByClaimId: string | null
): ProfileMemoryGraphClaimRecord {
  if (
    !claim.payload.active &&
    claim.payload.validTo === recordedAt &&
    claim.payload.endedAt === recordedAt &&
    claim.payload.endedByClaimId === endedByClaimId
  ) {
    return claim;
  }
  return createSchemaEnvelopeV1(
    PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
    {
      ...claim.payload,
      active: false,
      validTo: claim.payload.validTo ?? recordedAt,
      endedAt: claim.payload.endedAt ?? recordedAt,
      endedByClaimId
    },
    recordedAt
  );
}

/**
 * Merges one desired claim envelope into an existing claim without dropping prior support refs.
 * Fact-backed current claims fail closed on stale projection/entity lineage because live fact
 * mutation only carries the winning fact id plus rebuilt observation support.
 *
 * @param existing - Existing claim record.
 * @param desired - Desired claim record derived from the current canonical winner.
 * @param recordedAt - Timestamp for the merged envelope.
 * @returns Merged claim envelope.
 */
function mergeProfileMemoryGraphClaimRecord(
  existing: ProfileMemoryGraphClaimRecord,
  desired: ProfileMemoryGraphClaimRecord,
  recordedAt: string
): ProfileMemoryGraphClaimRecord {
  return rebuildProfileMemoryGraphEnvelope({
    record: existing,
    schemaName: PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
    payload: {
      ...existing.payload,
      ...desired.payload,
      derivedFromObservationIds: mergeSortedStrings(
        existing.payload.derivedFromObservationIds,
        desired.payload.derivedFromObservationIds
      ),
      projectionSourceIds: [...desired.payload.projectionSourceIds],
      entityRefIds: [...desired.payload.entityRefIds]
    },
    fallbackCreatedAt: recordedAt
  });
}

/**
 * Selects the deterministic current winner fact for each affected normalized key.
 *
 * @param facts - Canonical flat facts after the current mutation batch.
 * @param keys - Normalized keys touched by claim-authoritative candidates.
 * @returns Winner fact by normalized key.
 */
function selectCurrentWinnerFactsByKey(
  facts: readonly ProfileFactRecord[],
  keys: ReadonlySet<string>
): Map<string, ProfileFactRecord> {
  return selectProfileMemoryGraphCurrentWinnerFactsByKey(facts, keys).winners;
}

/**
 * Builds one deterministic current-claim id from the canonical family/key/value triple.
 *
 * @param payload - Stable claim identity payload.
 * @returns Deterministic claim id.
 */
function buildProfileMemoryGraphClaimId(payload: {
  family: string;
  normalizedKey: string;
  normalizedValue: string;
}): string {
  return `claim_${sha256HexFromCanonicalJson(payload).slice(0, 24)}`;
}

/**
 * Builds one deterministic source-fingerprint surrogate for a canonical graph claim.
 *
 * @param payload - Stable claim identity payload.
 * @returns Deterministic fingerprint string.
 */
function buildProfileMemoryGraphClaimSourceFingerprint(payload: {
  family: string;
  normalizedKey: string;
  normalizedValue: string;
}): string {
  return sha256HexFromCanonicalJson(payload).slice(0, 32);
}

/**
 * Maps one flat fact source string onto the bounded graph-backed source-tier contract.
 *
 * @param source - Canonical flat fact source string.
 * @returns Graph-backed source tier.
 */
function toGraphSourceTierFromSource(source: string): ProfileMemoryGraphSourceTier {
  const normalizedSource = source.trim().toLowerCase();
  if (normalizedSource.startsWith("conversation.")) {
    return "validated_structured_candidate";
  }
  if (normalizedSource.startsWith("profile_state_reconciliation.")) {
    return "reconciliation_or_projection";
  }
  if (
    normalizedSource.startsWith("language_understanding.") ||
    normalizedSource.startsWith("assistant.") ||
    normalizedSource.startsWith("semantic_memory.")
  ) {
    return "assistant_inference";
  }
  return "explicit_user_statement";
}

/**
 * Maps one flat fact source string onto the bounded graph-backed time-source contract.
 *
 * @param source - Canonical flat fact source string.
 * @returns Graph-backed time source.
 */
function toGraphTimeSourceFromSource(source: string): ProfileMemoryGraphTimeSource {
  const normalizedSource = source.trim().toLowerCase();
  if (normalizedSource.startsWith("conversation.")) {
    return "asserted_at";
  }
  if (normalizedSource.startsWith("profile_state_reconciliation.")) {
    return "system_generated";
  }
  if (
    normalizedSource.startsWith("language_understanding.") ||
    normalizedSource.startsWith("assistant.") ||
    normalizedSource.startsWith("semantic_memory.")
  ) {
    return "inferred";
  }
  return "user_stated";
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
 * Merges two string lists into a deterministic sorted unique collection.
 *
 * @param left - Existing values.
 * @param right - Incoming values.
 * @returns Sorted merged values.
 */
function mergeSortedStrings(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right])].sort((first, second) => first.localeCompare(second));
}

/**
 * Compares two claim records for deterministic persistence ordering.
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
 * Compares two claim records for canonical equality without relying on object identity.
 *
 * @param left - Left claim record.
 * @param right - Right claim record.
 * @returns `true` when the records are equivalent.
 */
function graphClaimRecordsEqual(
  left: ProfileMemoryGraphClaimRecord,
  right: ProfileMemoryGraphClaimRecord
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
