/**
 * @fileoverview Small support helpers shared by graph-state normalization and live mutation paths.
 */
import type { ProfileFactRecord } from "../profileMemory";
import { createSchemaEnvelopeV1 } from "../schemaEnvelope";
import type { SchemaEnvelopeV1 } from "../types";
import { getProfileMemoryFamilyRegistryEntry } from "./profileMemoryFamilyRegistry";
import type { ProfileMemoryGraphState } from "./profileMemoryGraphContracts";
import type { ProfileEpisodeRecord } from "./profileMemoryEpisodeContracts";
import { inferGovernanceFamilyForNormalizedKey } from "./profileMemoryGovernanceFamilyInference";
import { buildProfileMemoryGraphIndexState, buildProfileMemoryGraphReadModel } from "./profileMemoryGraphIndexing";

/**
 * Returns the first non-empty string in one candidate collection.
 *
 * @param values - Candidate string values.
 * @returns First non-empty string, or `null`.
 */
export function firstNonEmptyString(values: readonly string[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

/**
 * Coerces one timestamp candidate to ISO format with a caller-supplied fallback.
 *
 * @param value - Unknown timestamp candidate.
 * @param fallback - Fallback ISO timestamp.
 * @returns Valid ISO timestamp string.
 */
export function safeIsoOrFallback(value: unknown, fallback: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return Number.isFinite(Date.parse(trimmed))
    ? new Date(Date.parse(trimmed)).toISOString()
    : fallback;
}

/**
 * Normalizes one persisted fact key for graph-backed current-state comparison.
 *
 * **Why it exists:**
 * Phase 3 graph repair and current-claim selection consume retained flat facts that are only
 * type-checked by outer state normalization, so shared callers need one deterministic key
 * canonicalization rule instead of assuming persisted fact keys were already trimmed and lowercased.
 *
 * **What it talks to:**
 * - Uses local string normalization logic within this module.
 *
 * @param key - Persisted fact key candidate.
 * @returns Canonical normalized graph key.
 */
export function normalizeProfileMemoryGraphFactKey(key: string): string {
  return key.trim().toLowerCase();
}

/**
 * Normalizes one retained flat-fact value for graph-backed identity and backfill comparison.
 *
 * **Why it exists:**
 * Phase 3 graph repair consumes retained flat facts that are only type-checked by outer state
 * normalization, so shared callers need one deterministic value canonicalization rule before
 * comparing winner semantics or hashing synthetic backfill identities.
 *
 * **What it talks to:**
 * - Uses local string normalization logic within this module.
 *
 * @param value - Retained flat-fact value candidate.
 * @returns Canonical normalized graph value.
 */
export function normalizeProfileMemoryGraphFactValue(value: string): string {
  return value.trim();
}

/**
 * Normalizes one retained flat-fact source-task id for graph repair and reuse matching.
 *
 * **Why it exists:**
 * Phase 3 legacy fact backfill consumes retained flat facts that are only type-checked by outer
 * state normalization, so padded task ids would otherwise split reusable observation signatures
 * and synthetic graph backfill fingerprints from already-canonical graph state.
 *
 * **What it talks to:**
 * - Uses local string normalization logic within this module.
 *
 * @param value - Retained flat-fact source-task id candidate.
 * @returns Trimmed canonical task id, or `null` when the candidate is blank.
 */
export function normalizeProfileMemoryGraphFactSourceTaskId(
  value: string | null | undefined
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Normalizes one retained flat-fact source identifier for graph repair and deterministic graph ids.
 *
 * **Why it exists:**
 * Phase 3 legacy fact backfill consumes retained flat facts that are only type-checked by outer
 * state normalization, so padded or mis-cased source identifiers would otherwise hash to second
 * synthetic observation ids and backfill fingerprints even when the semantic source is unchanged.
 *
 * **What it talks to:**
 * - Uses local string normalization logic within this module.
 *
 * @param value - Retained flat-fact source identifier candidate.
 * @returns Trimmed lowercased source id, or an empty string when the candidate is blank.
 */
export function normalizeProfileMemoryGraphFactSource(
  value: string | null | undefined
): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

/**
 * Evaluates whether one retained flat fact should still participate in graph-backed current-state
 * repair.
 *
 * **Why it exists:**
 * Phase 3 legacy graph backfill consumes retained flat facts that are only type-checked by outer
 * state normalization, so whitespace-only `supersededAt` values would otherwise suppress active
 * facts out of reused-observation matching and current-winner repair.
 *
 * **What it talks to:**
 * - Uses local string normalization logic within this module.
 *
 * @param fact - Retained flat fact candidate.
 * @returns `true` when the fact remains active for graph-backed repair.
 */
export function isActiveProfileMemoryGraphFact(fact: ProfileFactRecord): boolean {
  if (fact.status === "superseded") {
    return false;
  }
  if (fact.supersededAt === null) {
    return true;
  }
  return fact.supersededAt.trim().length === 0;
}

/**
 * Normalizes one retained source-record id used by graph projection lineage and retained fact
 * winner tie-breaks.
 *
 * **Why it exists:**
 * Phase 3 graph repair consumes persisted flat fact and episode identifiers that are only
 * type-checked by outer state normalization, so graph lineage helpers and retained fact current-
 * winner comparison need one deterministic trim rule before comparing or emitting source-record
 * ids.
 *
 * **What it talks to:**
 * - Uses local string normalization logic within this module.
 *
 * @param value - Retained source-record id candidate.
 * @returns Trimmed canonical id, or `null` when the candidate is blank.
 */
export function normalizeProfileMemoryGraphSourceRecordId(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Collects canonical retained episode ids that load normalization may treat as surviving event
 * projection sources.
 *
 * @param episodes - Retained canonical episodes available during load normalization.
 * @returns Canonical surviving episode ids, or `undefined` when no retained episodes exist.
 */
export function collectValidProfileMemoryGraphEpisodeProjectionSourceIds(
  episodes: readonly ProfileEpisodeRecord[]
): ReadonlySet<string> | undefined {
  if (episodes.length === 0) {
    return undefined;
  }
  return new Set(
    episodes.flatMap((episode) => {
      const normalizedEpisodeId = normalizeProfileMemoryGraphSourceRecordId(episode.id);
      return normalizedEpisodeId === null ? [] : [normalizedEpisodeId];
    })
  );
}

/**
 * Compares two active facts for graph-backed current-winner selection.
 *
 * **Why it exists:**
 * Phase 3 legacy fact backfill and current-claim reconciliation must agree on one deterministic
 * winner ordering so padded or malformed retained flat facts do not produce diverging graph claim
 * repair outcomes for the same canonical key.
 *
 * **What it talks to:**
 * - Uses local timestamp and scalar comparison logic within this module.
 *
 * @param left - Left fact candidate.
 * @param right - Right fact candidate.
 * @returns Positive when `left` should replace `right`.
 */
export function compareProfileMemoryGraphFactPriority(
  left: ProfileFactRecord,
  right: ProfileFactRecord
): number {
  const leftStatusWeight = left.status === "confirmed" ? 2 : 1;
  const rightStatusWeight = right.status === "confirmed" ? 2 : 1;
  if (leftStatusWeight !== rightStatusWeight) {
    return leftStatusWeight - rightStatusWeight;
  }
  const leftConfidence = normalizeProfileMemoryGraphFactConfidenceForComparison(left.confidence);
  const rightConfidence = normalizeProfileMemoryGraphFactConfidenceForComparison(right.confidence);
  if (leftConfidence !== rightConfidence) {
    return leftConfidence - rightConfidence;
  }
  const leftObservedAt = normalizeProfileMemoryGraphFactTimestampForComparison(left.observedAt);
  const rightObservedAt = normalizeProfileMemoryGraphFactTimestampForComparison(right.observedAt);
  if (leftObservedAt !== rightObservedAt) {
    return leftObservedAt.localeCompare(rightObservedAt);
  }
  const leftLastUpdatedAt = normalizeProfileMemoryGraphFactTimestampForComparison(
    left.lastUpdatedAt
  );
  const rightLastUpdatedAt = normalizeProfileMemoryGraphFactTimestampForComparison(
    right.lastUpdatedAt
  );
  if (leftLastUpdatedAt !== rightLastUpdatedAt) {
    return leftLastUpdatedAt.localeCompare(rightLastUpdatedAt);
  }
  const leftId = normalizeProfileMemoryGraphSourceRecordId(left.id) ?? "";
  const rightId = normalizeProfileMemoryGraphSourceRecordId(right.id) ?? "";
  return leftId.localeCompare(rightId);
}

/**
 * Selects graph-backed current-winner facts while fail-closing preserve-prior ambiguity.
 *
 * **Why it exists:**
 * Phase 3 current-claim reconciliation and legacy fact backfill must agree when same-key
 * different-value active facts are too ambiguous to synthesize one current winner. Preserve-prior
 * families with no confirmed incumbent should keep support observations but not manufacture a
 * graph-backed current claim.
 *
 * **What it talks to:**
 * - Uses `inferGovernanceFamilyForNormalizedKey` (import) from
 *   `./profileMemoryGovernanceFamilyInference`.
 * - Uses `getProfileMemoryFamilyRegistryEntry` (import) from `./profileMemoryFamilyRegistry`.
 * - Uses `compareProfileMemoryGraphFactPriority` (local export) from this module.
 *
 * @param facts - Canonical flat facts under evaluation.
 * @param keys - Normalized keys eligible for current-winner selection.
 * @returns Deterministic winner facts plus keys suppressed for ambiguity.
 */
export function selectProfileMemoryGraphCurrentWinnerFactsByKey(
  facts: readonly ProfileFactRecord[],
  keys: ReadonlySet<string>
): {
  winners: Map<string, ProfileFactRecord>;
  suppressedKeys: ReadonlySet<string>;
} {
  const activeFactsByKey = new Map<string, ProfileFactRecord[]>();
  for (const fact of facts) {
    const normalizedKey = normalizeProfileMemoryGraphFactKey(fact.key);
    if (!isActiveProfileMemoryGraphFact(fact) || !keys.has(normalizedKey)) {
      continue;
    }
    const bucket = activeFactsByKey.get(normalizedKey) ?? [];
    bucket.push(fact);
    activeFactsByKey.set(normalizedKey, bucket);
  }

  const winners = new Map<string, ProfileFactRecord>();
  const suppressedKeys = new Set<string>();
  for (const [key, activeFacts] of activeFactsByKey.entries()) {
    if (activeFacts.length === 1) {
      winners.set(key, activeFacts[0]!);
      continue;
    }

    const distinctValues = new Set(activeFacts.map((fact) => normalizeProfileMemoryGraphFactValue(fact.value)));
    if (distinctValues.size <= 1) {
      winners.set(key, selectHighestPriorityProfileMemoryGraphFact(activeFacts));
      continue;
    }

    const families = new Set(
      activeFacts.map((fact) => inferGovernanceFamilyForNormalizedKey(key, fact.value))
    );
    if (families.size !== 1) {
      suppressedKeys.add(key);
      continue;
    }

    const family = [...families][0]!;
    const displacementPolicy = getProfileMemoryFamilyRegistryEntry(family).displacementPolicy;
    if (displacementPolicy === "preserve_prior_on_conflict") {
      const confirmedFacts = activeFacts.filter((fact) => fact.status === "confirmed");
      if (confirmedFacts.length === 0) {
        suppressedKeys.add(key);
        continue;
      }
    }

    winners.set(key, selectHighestPriorityProfileMemoryGraphFact(activeFacts));
  }

  return {
    winners,
    suppressedKeys
  };
}

/**
 * Selects the deterministic highest-priority fact from one active fact collection.
 *
 * @param facts - Active facts under comparison.
 * @returns Highest-priority fact.
 */
function selectHighestPriorityProfileMemoryGraphFact(
  facts: readonly ProfileFactRecord[]
): ProfileFactRecord {
  let winner = facts[0]!;
  for (const fact of facts.slice(1)) {
    if (compareProfileMemoryGraphFactPriority(fact, winner) > 0) {
      winner = fact;
    }
  }
  return winner;
}

/**
 * Normalizes one retained flat-fact confidence value for graph current-winner comparison.
 *
 * @param value - Retained flat-fact confidence candidate.
 * @returns Bounded comparable confidence, or `0` when the candidate is malformed.
 */
function normalizeProfileMemoryGraphFactConfidenceForComparison(value: number): number {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
}

/**
 * Normalizes one retained flat-fact timestamp so graph current-winner selection compares canonical
 * time order instead of raw persisted string order.
 *
 * @param value - Retained flat-fact timestamp candidate.
 * @returns Comparable canonical timestamp, or trimmed raw text when parsing fails.
 */
function normalizeProfileMemoryGraphFactTimestampForComparison(value: string): string {
  const trimmed = value.trim();
  return Number.isFinite(Date.parse(trimmed))
    ? new Date(Date.parse(trimmed)).toISOString()
    : trimmed;
}

/**
 * Rewraps one retained graph envelope while preserving its canonical envelope timestamp.
 *
 * @param input - Existing retained envelope, repaired payload, schema name, and deterministic fallback.
 * @returns Rebuilt envelope with preserved canonical `createdAt`.
 */
export function rebuildProfileMemoryGraphEnvelope<TCurrentPayload, TNextPayload>(input: {
  record: SchemaEnvelopeV1<TCurrentPayload>;
  schemaName: string;
  payload: TNextPayload;
  fallbackCreatedAt: string;
}): SchemaEnvelopeV1<TNextPayload> {
  return createSchemaEnvelopeV1(
    input.schemaName,
    input.payload,
    safeIsoOrFallback(input.record.createdAt, input.fallbackCreatedAt)
  );
}

/**
 * Rebuilds one canonical graph state after callers finish bounded normalization or mutation work.
 *
 * @param input - Canonical graph payload lanes and derived-surface rebuild inputs.
 * @returns Stable graph state with rebuilt indexes and read model.
 */
export function finalizeProfileMemoryGraphState(input: {
  graph: ProfileMemoryGraphState;
  updatedAt: string;
  observations: ProfileMemoryGraphState["observations"];
  claims: ProfileMemoryGraphState["claims"];
  events: ProfileMemoryGraphState["events"];
  mutationJournal: ProfileMemoryGraphState["mutationJournal"];
  compaction: ProfileMemoryGraphState["compaction"];
}): ProfileMemoryGraphState {
  return {
    ...input.graph,
    updatedAt: input.updatedAt,
    observations: input.observations,
    claims: input.claims,
    events: input.events,
    mutationJournal: input.mutationJournal,
    indexes: buildProfileMemoryGraphIndexState({
      claims: input.claims,
      events: input.events
    }),
    readModel: buildProfileMemoryGraphReadModel({
      claims: input.claims,
      mutationJournal: input.mutationJournal,
      rebuiltAt: input.updatedAt
    }),
    compaction: input.compaction
  };
}
