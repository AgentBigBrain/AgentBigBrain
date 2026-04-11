/**
 * @fileoverview Fail-closed legacy fact backfill helpers for additive graph state.
 */

import { sha256HexFromCanonicalJson } from "../normalizers/canonicalizationRules";
import type { ProfileFactRecord } from "../profileMemory";
import { upsertProfileMemoryGraphObservations } from "./profileMemoryGraphObservationSupport";
import { reconcileProfileMemoryCurrentClaims } from "./profileMemoryGraphClaimSupport";
import type {
  ProfileMemoryGraphClaimRecord,
  ProfileMemoryGraphObservationRecord
} from "./profileMemoryGraphContracts";
import {
  isActiveProfileMemoryGraphFact,
  normalizeProfileMemoryGraphFactKey,
  normalizeProfileMemoryGraphFactSource,
  normalizeProfileMemoryGraphFactSourceTaskId,
  normalizeProfileMemoryGraphFactValue,
  normalizeProfileMemoryGraphSourceRecordId,
} from "./profileMemoryGraphStateSupport";
import { isProfileMemoryGraphClaimCurrentSurfaceEligible } from "./profileMemoryGraphClaimSurfaceEligibilitySupport";
import { governProfileMemoryCandidates } from "./profileMemoryTruthGovernance";
import type { GovernedProfileFactCandidate } from "./profileMemoryTruthGovernanceContracts";

/**
 * Backfills graph observations and current claims from legacy active flat facts when the loaded
 * graph state no longer has one aligned active current-claim lane, reusing any matching surviving
 * observation evidence already present in the graph.
 *
 * The repair stays fail-closed: only current-state or end-state governable facts participate, so
 * unsupported legacy sources and support-only-only history do not auto-promote into graph truth.
 *
 * @param input - Existing graph claim or observation lanes plus canonical flat facts.
 * @returns Backfilled graph observations and claims when legacy current-state facts qualify.
 */
export function backfillProfileMemoryGraphFromLegacyFacts(input: {
  existingObservations: readonly ProfileMemoryGraphObservationRecord[];
  existingClaims: readonly ProfileMemoryGraphClaimRecord[];
  facts: readonly ProfileFactRecord[];
  recordedAt: string;
}): {
  nextObservations: ProfileMemoryGraphObservationRecord[];
  nextClaims: ProfileMemoryGraphClaimRecord[];
  changed: boolean;
} {
  const activeFactCandidates = input.facts
    .filter((fact) => isActiveProfileMemoryGraphFact(fact))
    .map((fact) => ({
      key: fact.key,
      value: fact.value,
      sensitive: fact.sensitive,
      sourceTaskId: fact.sourceTaskId,
      source: fact.source,
      observedAt: fact.observedAt,
      confidence: fact.confidence
    }));
  if (activeFactCandidates.length === 0) {
    return {
      nextObservations: [...input.existingObservations],
      nextClaims: [...input.existingClaims],
      changed: false
    };
  }

  const factDecisions = governProfileMemoryCandidates({
    factCandidates: activeFactCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  }).factDecisions.filter(
    (entry) =>
      entry.decision.action === "allow_current_state" ||
      entry.decision.action === "allow_end_state"
  );
  if (factDecisions.length === 0) {
    return {
      nextObservations: [...input.existingObservations],
      nextClaims: [...input.existingClaims],
      changed: false
    };
  }

  const reusableObservationSignatures = collectReusableObservationSignatures(input.existingObservations);
  const factDecisionsNeedingObservationBackfill = factDecisions.filter(
    (entry) => !reusableObservationSignatures.has(
      buildLegacyFactBackfillObservationSignature({
        family: entry.decision.family,
        key: entry.candidate.key,
        value: entry.candidate.value,
        sensitive: entry.candidate.sensitive,
        sourceTaskId: entry.candidate.sourceTaskId,
        evidenceClass: entry.decision.evidenceClass,
        observedAt: entry.candidate.observedAt,
        recordedAt: input.recordedAt
      })
    )
  );
  const observationResult = factDecisionsNeedingObservationBackfill.length === 0
    ? {
        nextObservations: [...input.existingObservations],
        touchedObservationIds: [],
        changed: false
      }
    : upsertProfileMemoryGraphObservations({
        existingObservations: input.existingObservations,
        factDecisions: factDecisionsNeedingObservationBackfill,
        sourceFingerprint: buildProfileMemoryGraphLegacyFactBackfillFingerprint(
          factDecisionsNeedingObservationBackfill,
          input.recordedAt
        ),
        recordedAt: input.recordedAt
      });
  const claimResult = reconcileProfileMemoryCurrentClaims({
    existingClaims: input.existingClaims,
    observations: observationResult.nextObservations,
    facts: preserveAnchoredCurrentWinnerFacts({
      existingClaims: input.existingClaims,
      facts: input.facts
    }),
    factDecisions,
    recordedAt: input.recordedAt
  });

  return {
    nextObservations: observationResult.nextObservations,
    nextClaims: claimResult.nextClaims,
    changed: observationResult.changed || claimResult.changed
  };
}

/**
 * Preserves retained fact winners for keys already anchored to one active current-surface graph
 * claim. This prevents conflicting flat compatibility facts from displacing a valid graph lane
 * while still letting stale, invalid, or unanchored lanes repair from retained facts.
 *
 * @param input - Existing graph claims plus retained flat facts.
 * @returns Fact set narrowed only for keys with one anchored current graph winner.
 */
function preserveAnchoredCurrentWinnerFacts(input: {
  existingClaims: readonly ProfileMemoryGraphClaimRecord[];
  facts: readonly ProfileFactRecord[];
}): readonly ProfileFactRecord[] {
  const activeFactsById = new Map<string, ProfileFactRecord>();
  for (const fact of input.facts) {
    if (!isActiveProfileMemoryGraphFact(fact)) {
      continue;
    }
    const normalizedFactId = normalizeProfileMemoryGraphSourceRecordId(fact.id);
    if (normalizedFactId === null) {
      continue;
    }
    activeFactsById.set(normalizedFactId, fact);
  }
  if (activeFactsById.size === 0) {
    return input.facts;
  }

  const eligibleClaimsByKey = new Map<string, ProfileMemoryGraphClaimRecord[]>();
  for (const claim of input.existingClaims) {
    if (!claim.payload.active || !isProfileMemoryGraphClaimCurrentSurfaceEligible(claim)) {
      continue;
    }
    const bucket = eligibleClaimsByKey.get(claim.payload.normalizedKey) ?? [];
    bucket.push(claim);
    eligibleClaimsByKey.set(claim.payload.normalizedKey, bucket);
  }

  const anchoredFactIdsByKey = new Map<string, ReadonlySet<string>>();
  for (const [key, claims] of eligibleClaimsByKey.entries()) {
    if (claims.length !== 1) {
      continue;
    }
    const claim = claims[0]!;
    const anchoredFactIds = claim.payload.projectionSourceIds.flatMap((projectionSourceId) => {
      const normalizedProjectionSourceId =
        normalizeProfileMemoryGraphSourceRecordId(projectionSourceId);
      if (normalizedProjectionSourceId === null) {
        return [];
      }
      const fact = activeFactsById.get(normalizedProjectionSourceId);
      if (!fact) {
        return [];
      }
      return normalizeProfileMemoryGraphFactKey(fact.key) === claim.payload.normalizedKey &&
        normalizeProfileMemoryGraphFactValue(fact.value) === claim.payload.normalizedValue
        ? [normalizedProjectionSourceId]
        : [];
    });
    if (anchoredFactIds.length === 0) {
      continue;
    }
    anchoredFactIdsByKey.set(key, new Set(anchoredFactIds));
  }

  if (anchoredFactIdsByKey.size === 0) {
    return input.facts;
  }

  return input.facts.filter((fact) => {
    const normalizedKey = normalizeProfileMemoryGraphFactKey(fact.key);
    const anchoredFactIds = anchoredFactIdsByKey.get(normalizedKey);
    if (!anchoredFactIds) {
      return true;
    }
    const normalizedFactId = normalizeProfileMemoryGraphSourceRecordId(fact.id);
    return normalizedFactId !== null && anchoredFactIds.has(normalizedFactId);
  });
}

/**
 * Builds one deterministic synthetic source fingerprint for legacy flat-fact graph backfill.
 *
 * @param factDecisions - Governed current-state or end-state fact decisions selected for backfill.
 * @param recordedAt - Batch-level normalization timestamp used for invalid timestamp fallback.
 * @returns Deterministic synthetic backfill fingerprint.
 */
function buildProfileMemoryGraphLegacyFactBackfillFingerprint(
  factDecisions: readonly GovernedProfileFactCandidate[],
  recordedAt: string
): string {
  return `graph_fact_backfill_${sha256HexFromCanonicalJson(
      factDecisions.map((entry) => ({
        family: entry.decision.family,
        key: normalizeProfileMemoryGraphFactKey(entry.candidate.key),
        value: normalizeProfileMemoryGraphFactValue(entry.candidate.value),
        source: normalizeProfileMemoryGraphFactSource(entry.candidate.source),
        sourceTaskId: normalizeProfileMemoryGraphFactSourceTaskId(entry.candidate.sourceTaskId),
        observedAt: safeIsoOrFallback(entry.candidate.observedAt, recordedAt)
      }))
  ).slice(0, 24)}`;
}

/**
 * Collects reusable non-redacted observation signatures already present in the graph lane.
 *
 * @param observations - Existing graph observations from persisted state.
 * @returns Reusable observation signatures.
 */
function collectReusableObservationSignatures(
  observations: readonly ProfileMemoryGraphObservationRecord[]
): ReadonlySet<string> {
  return new Set(
    observations
      .filter((observation) => observation.payload.redactionState !== "redacted")
      .map((observation) =>
        buildLegacyFactBackfillObservationSignature({
          family: observation.payload.family,
          key: observation.payload.normalizedKey,
          value: observation.payload.normalizedValue,
          sensitive: observation.payload.sensitive,
          sourceTaskId: observation.payload.sourceTaskId,
          evidenceClass: toLegacyFactBackfillEvidenceClass(observation),
          observedAt: observation.payload.observedAt,
          recordedAt: observation.payload.observedAt
        })
      )
  );
}

/**
 * Builds one stable signature for observation reuse during legacy fact backfill.
 *
 * @param input - Stable observation identity fields.
 * @returns Canonical comparison signature.
 */
function buildLegacyFactBackfillObservationSignature(input: {
  family: string | null;
  key: string | null;
  value: string | null;
  sensitive: boolean;
  sourceTaskId: string | null;
  evidenceClass: GovernedProfileFactCandidate["decision"]["evidenceClass"];
  observedAt: string | null | undefined;
  recordedAt: string;
}): string {
  return sha256HexFromCanonicalJson({
    family: input.family,
    normalizedKey:
      typeof input.key === "string" ? normalizeProfileMemoryGraphFactKey(input.key) : null,
    normalizedValue:
      typeof input.value === "string" ? normalizeProfileMemoryGraphFactValue(input.value) : null,
    sensitive: input.sensitive,
    sourceTaskId: normalizeProfileMemoryGraphFactSourceTaskId(input.sourceTaskId),
    sourceTier: toLegacyFactBackfillSourceTier(input.evidenceClass),
    assertedAt: safeIsoOrFallback(input.observedAt, input.recordedAt),
    observedAt: safeIsoOrFallback(input.observedAt, input.recordedAt),
    timePrecision: "instant",
    timeSource: toLegacyFactBackfillTimeSource(input.evidenceClass),
    entityRefIds: []
  });
}

/**
 * Maps one graph observation back onto the bounded evidence class used for reuse signatures.
 *
 * @param observation - Existing graph observation record.
 * @returns Comparable evidence class.
 */
function toLegacyFactBackfillEvidenceClass(
  observation: ProfileMemoryGraphObservationRecord
): GovernedProfileFactCandidate["decision"]["evidenceClass"] {
  switch (observation.payload.sourceTier) {
    case "validated_structured_candidate":
      return "validated_structured_candidate";
    case "reconciliation_or_projection":
      return "reconciliation_or_projection";
    case "assistant_inference":
      return "assistant_inference";
    case "explicit_user_statement":
      switch (observation.payload.timeSource) {
        case "asserted_at":
          return "validated_structured_candidate";
        case "system_generated":
          return "reconciliation_or_projection";
        case "inferred":
          return "assistant_inference";
        case "observed_at":
        case "user_stated":
          return "user_explicit_fact";
      }
  }
}

/**
 * Maps one governance evidence class onto the bounded graph-backed source tier for reuse matching.
 *
 * @param evidenceClass - Governance evidence class.
 * @returns Comparable source tier.
 */
function toLegacyFactBackfillSourceTier(
  evidenceClass: GovernedProfileFactCandidate["decision"]["evidenceClass"]
): "explicit_user_statement" | "validated_structured_candidate" | "reconciliation_or_projection" | "assistant_inference" {
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
 * Maps one governance evidence class onto the bounded graph-backed time source for reuse matching.
 *
 * @param evidenceClass - Governance evidence class.
 * @returns Comparable time source.
 */
function toLegacyFactBackfillTimeSource(
  evidenceClass: GovernedProfileFactCandidate["decision"]["evidenceClass"]
): "asserted_at" | "system_generated" | "inferred" | "user_stated" {
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
