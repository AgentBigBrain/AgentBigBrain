/**
 * @fileoverview Fail-closed legacy claim-lineage observation backfill helpers.
 */

import { sha256HexFromCanonicalJson } from "../normalizers/canonicalizationRules";
import { createSchemaEnvelopeV1 } from "../schemaEnvelope";
import { collectProfileMemoryGraphNonAuthoritativeAmbiguousClaimIds } from "./profileMemoryGraphClaimAmbiguitySupport";
import { isProfileMemoryGraphClaimCurrentSurfaceEligible } from "./profileMemoryGraphClaimSurfaceEligibilitySupport";
import type {
  ProfileMemoryGraphClaimRecord,
  ProfileMemoryGraphObservationRecord
} from "./profileMemoryGraphContracts";
import { PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME } from "./profileMemoryGraphContracts";

/**
 * Backfills graph observations or observation lineage from legacy active claims when those claims
 * still have no usable observation linkage after load normalization.
 *
 * **Why it exists:**
 * Earlier Phase 3 slices repaired empty-journal replay coverage for active claims, but older graph
 * payloads can still arrive with current claims and no usable observation lineage. This bounded
 * helper reconstructs or reconnects one minimal observation lane from those active claims so
 * lineage stays coherent without widening retrieval or mutating retrieval ownership.
 *
 * **What it talks to:**
 * - Uses `createSchemaEnvelopeV1` (import `createSchemaEnvelopeV1`) from `../schemaEnvelope`.
 * - Uses graph record contracts from `./profileMemoryGraphContracts`.
 * - Uses `sha256HexFromCanonicalJson` (import `sha256HexFromCanonicalJson`) from
 *   `../normalizers/canonicalizationRules`.
 *
 * @param input - Existing graph observations and claims plus a deterministic normalization time.
 * @returns Backfilled observations and claim lineage when bounded legacy repair applies.
 */
export function backfillProfileMemoryGraphObservationsFromLegacyClaims(input: {
  existingObservations: readonly ProfileMemoryGraphObservationRecord[];
  existingClaims: readonly ProfileMemoryGraphClaimRecord[];
  recordedAt: string;
}): {
  nextObservations: ProfileMemoryGraphObservationRecord[];
  nextClaims: ProfileMemoryGraphClaimRecord[];
  changed: boolean;
} {
  const ambiguousClaimIds = collectProfileMemoryGraphNonAuthoritativeAmbiguousClaimIds(
    input.existingClaims
  );
  const usableObservationsById = new Map(
    input.existingObservations
      .filter((observation) => observation.payload.redactionState !== "redacted")
      .map((observation) => [observation.payload.observationId, observation] as const)
  );
  const eligibleClaims = input.existingClaims.filter(
    (claim) =>
      claim.payload.active &&
      claim.payload.redactionState !== "redacted" &&
      hasUsableClaimSemanticIdentity(claim) &&
      isProfileMemoryGraphClaimCurrentSurfaceEligible(claim) &&
      !ambiguousClaimIds.has(claim.payload.claimId) &&
      !hasUsableObservationLineage(claim, usableObservationsById)
  );
  if (eligibleClaims.length === 0) {
    return {
      nextObservations: [...input.existingObservations],
      nextClaims: [...input.existingClaims],
      changed: false
    };
  }

  const nextObservationMap = new Map(
    input.existingObservations.map((observation) => [observation.payload.observationId, observation])
  );
  const observationIdBySignature = new Map<string, string>();
  for (const observation of [...input.existingObservations].sort(compareObservationRecords)) {
    if (observation.payload.redactionState === "redacted") {
      continue;
    }
    const signature = buildLegacyClaimObservationSignatureFromObservation(observation);
    if (!observationIdBySignature.has(signature)) {
      observationIdBySignature.set(signature, observation.payload.observationId);
    }
  }

  const observationIdByClaimId = new Map<string, string>();
  let changed = false;
  for (const claim of eligibleClaims) {
    const observationSignature = buildLegacyClaimObservationSignatureFromClaim(
      claim,
      input.recordedAt
    );
    const existingObservationId = observationIdBySignature.get(observationSignature);
    if (existingObservationId) {
      observationIdByClaimId.set(claim.payload.claimId, existingObservationId);
      changed = true;
      continue;
    }
    const observation = buildProfileMemoryGraphObservationFromLegacyClaim(claim, input.recordedAt);
    nextObservationMap.set(observation.payload.observationId, observation);
    observationIdBySignature.set(observationSignature, observation.payload.observationId);
    observationIdByClaimId.set(claim.payload.claimId, observation.payload.observationId);
    changed = true;
  }

  const nextClaims = input.existingClaims.map((claim) => {
    const observationId = observationIdByClaimId.get(claim.payload.claimId);
    if (!observationId) {
      return claim;
    }
    return createSchemaEnvelopeV1(
      claim.schemaName,
      {
        ...claim.payload,
        derivedFromObservationIds: [observationId]
      },
      input.recordedAt
    );
  });

  return {
    nextObservations: [...nextObservationMap.values()].sort(compareObservationRecords),
    nextClaims: nextClaims.sort(compareClaimRecords),
    changed
  };
}

/**
 * Builds one deterministic synthetic observation from one legacy active claim.
 *
 * **Why it exists:**
 * Legacy graph states may have current claims without any stored observation lineage. This keeps
 * the repair deterministic and localized so normalization can reconstruct the minimal observation
 * evidence needed for lineage without depending on flat facts or extractor ownership.
 *
 * **What it talks to:**
 * - Uses `createSchemaEnvelopeV1` (import `createSchemaEnvelopeV1`) from `../schemaEnvelope`.
 * - Uses `sha256HexFromCanonicalJson` (import `sha256HexFromCanonicalJson`) from
 *   `../normalizers/canonicalizationRules`.
 *
 * @param claim - Legacy active claim missing observation lineage.
 * @param recordedAt - Deterministic normalization timestamp.
 * @returns Synthetic bounded observation envelope.
 */
function buildProfileMemoryGraphObservationFromLegacyClaim(
  claim: ProfileMemoryGraphClaimRecord,
  recordedAt: string
): ProfileMemoryGraphObservationRecord {
  const assertedAt = resolveLegacyClaimObservationAssertedAt(claim, recordedAt);
  const observationId = `observation_${sha256HexFromCanonicalJson({
    claimId: claim.payload.claimId,
    family: claim.payload.family,
    normalizedKey: claim.payload.normalizedKey,
    normalizedValue: claim.payload.normalizedValue,
    sourceFingerprint: claim.payload.sourceFingerprint,
    assertedAt
  }).slice(0, 24)}`;
  return createSchemaEnvelopeV1(
    PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
    {
      observationId,
      stableRefId: claim.payload.stableRefId,
      family: claim.payload.family,
      normalizedKey: claim.payload.normalizedKey,
      normalizedValue: claim.payload.normalizedValue,
      redactionState: "not_requested",
      redactedAt: null,
      sensitive: claim.payload.sensitive,
      sourceTaskId: claim.payload.sourceTaskId,
      sourceFingerprint: claim.payload.sourceFingerprint,
      sourceTier: claim.payload.sourceTier,
      assertedAt,
      observedAt: assertedAt,
      timePrecision: claim.payload.timePrecision,
      timeSource: claim.payload.timeSource,
      entityRefIds: [...claim.payload.entityRefIds]
    },
    recordedAt
  );
}

/**
 * Builds one deterministic lineage signature from one claim-side observation repair candidate.
 *
 * @param claim - Legacy active claim missing observation lineage.
 * @param recordedAt - Deterministic normalization timestamp.
 * @returns Canonical signature used to reuse matching observation evidence.
 */
function buildLegacyClaimObservationSignatureFromClaim(
  claim: ProfileMemoryGraphClaimRecord,
  recordedAt: string
): string {
  const assertedAt = resolveLegacyClaimObservationAssertedAt(claim, recordedAt);
  return sha256HexFromCanonicalJson({
    stableRefId: claim.payload.stableRefId,
    family: claim.payload.family,
    normalizedKey: claim.payload.normalizedKey,
    normalizedValue: claim.payload.normalizedValue,
    sensitive: claim.payload.sensitive,
    sourceTaskId: claim.payload.sourceTaskId,
    sourceFingerprint: claim.payload.sourceFingerprint,
    sourceTier: claim.payload.sourceTier,
    assertedAt,
    observedAt: assertedAt,
    timePrecision: claim.payload.timePrecision,
    timeSource: claim.payload.timeSource,
    entityRefIds: [...claim.payload.entityRefIds]
  });
}

/**
 * Builds one deterministic lineage signature from one existing observation.
 *
 * @param observation - Existing non-redacted graph observation.
 * @returns Canonical signature used to reconnect detached claim lineage.
 */
function buildLegacyClaimObservationSignatureFromObservation(
  observation: ProfileMemoryGraphObservationRecord
): string {
  return sha256HexFromCanonicalJson({
    stableRefId: observation.payload.stableRefId,
    family: observation.payload.family,
    normalizedKey: observation.payload.normalizedKey,
    normalizedValue: observation.payload.normalizedValue,
    sensitive: observation.payload.sensitive,
    sourceTaskId: observation.payload.sourceTaskId,
    sourceFingerprint: observation.payload.sourceFingerprint,
    sourceTier: observation.payload.sourceTier,
    assertedAt: observation.payload.assertedAt,
    observedAt: observation.payload.observedAt,
    timePrecision: observation.payload.timePrecision,
    timeSource: observation.payload.timeSource,
    entityRefIds: [...observation.payload.entityRefIds]
  });
}

/**
 * Resolves one deterministic asserted-at timestamp for synthetic claim-lineage observations.
 *
 * @param claim - Legacy active claim missing observation lineage.
 * @param recordedAt - Deterministic normalization timestamp.
 * @returns Valid ISO asserted-at timestamp.
 */
function resolveLegacyClaimObservationAssertedAt(
  claim: ProfileMemoryGraphClaimRecord,
  recordedAt: string
): string {
  return safeIsoOrFallback(
    claim.payload.assertedAt ?? claim.payload.validFrom,
    recordedAt
  );
}

/**
 * Evaluates whether one claim still has at least one surviving aligned non-redacted observation
 * ref.
 *
 * @param claim - Legacy active claim candidate.
 * @param usableObservationsById - Surviving non-redacted observations by id.
 * @returns `true` when the claim already has usable lineage.
 */
function hasUsableObservationLineage(
  claim: ProfileMemoryGraphClaimRecord,
  usableObservationsById: ReadonlyMap<string, ProfileMemoryGraphObservationRecord>
): boolean {
  return claim.payload.derivedFromObservationIds.some((observationId) => {
    const observation = usableObservationsById.get(observationId);
    if (observation === undefined) {
      return false;
    }
    const sharesClaimSemanticLane =
      observation.payload.family === claim.payload.family &&
      observation.payload.normalizedKey === claim.payload.normalizedKey;
    if (!sharesClaimSemanticLane) {
      return true;
    }
    return observation.payload.normalizedValue === claim.payload.normalizedValue;
  });
}

/**
 * Evaluates whether one active claim carries a usable semantic identity for lineage repair.
 *
 * @param claim - Active graph claim candidate.
 * @returns `true` when the claim has non-blank family or normalized-key semantics plus one
 * non-blank current value.
 */
function hasUsableClaimSemanticIdentity(claim: ProfileMemoryGraphClaimRecord): boolean {
  return (
    claim.payload.family.trim().length > 0 &&
    claim.payload.normalizedKey.trim().length > 0 &&
    typeof claim.payload.normalizedValue === "string" &&
    claim.payload.normalizedValue.trim().length > 0
  );
}

/**
 * Orders observation records deterministically for normalized persistence.
 *
 * **Why it exists:**
 * The legacy backfill path should preserve one stable ordering contract so later replay repair,
 * compaction, and test expectations do not depend on map iteration order.
 *
 * **What it talks to:**
 * - Uses local record payload fields within this module.
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
 * Orders claim records deterministically for normalized persistence.
 *
 * **Why it exists:**
 * The legacy backfill path updates claim lineage during normalization, so the resulting claim list
 * must remain stable for later compaction and read-model rebuild steps.
 *
 * **What it talks to:**
 * - Uses local record payload fields within this module.
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
 * Coerces one timestamp candidate to ISO format with a caller-supplied fallback.
 *
 * **Why it exists:**
 * Legacy claim payloads can be incomplete or malformed, and the backfill must stay deterministic
 * instead of throwing or persisting invalid times.
 *
 * **What it talks to:**
 * - Uses local timestamp coercion logic within this module.
 *
 * @param value - Unknown timestamp candidate.
 * @param fallback - Fallback ISO timestamp.
 * @returns Valid ISO timestamp string.
 */
function safeIsoOrFallback(value: unknown, fallback: string): string {
  const trimmedValue = typeof value === "string" ? value.trim() : null;
  return trimmedValue && Number.isFinite(Date.parse(trimmedValue))
    ? new Date(Date.parse(trimmedValue)).toISOString()
    : fallback;
}
