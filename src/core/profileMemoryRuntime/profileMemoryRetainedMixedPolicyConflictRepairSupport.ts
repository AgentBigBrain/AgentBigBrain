/**
 * @fileoverview Focused helpers for mixed-policy retained active-fact conflict repair.
 */

import type { ProfileFactRecord } from "../profileMemory";
import { getProfileMemoryFamilyRegistryEntry } from "./profileMemoryFamilyRegistry";
import { inferGovernanceFamilyForNormalizedKey } from "./profileMemoryGovernanceFamilyInference";
import { MEMORY_REVIEW_FACT_CORRECTION_SOURCE } from "./profileMemoryTruthGovernanceSources";
import type { ProfileMemoryDisplacementPolicy } from "./profileMemoryTruthGovernanceContracts";

/**
 * Repairs malformed mixed-policy retained conflicts back into a live-upsert-valid active shape.
 *
 * **Why it exists:**
 * One retained same-key conflict group can straddle multiple family policies when governance
 * family inference depends on both key and value, such as `followup.*` keys whose `"resolved"`
 * end-state writes are `resolution_only` while unresolved values stay in the generic preserve
 * lane. Encrypted reload should replay those groups back into a shape the live upsert seam could
 * actually produce instead of leaving impossible active combinations behind.
 *
 * @param facts - Normalized retained facts under evaluation.
 * @returns Canonical retained facts with mixed-policy active conflicts replayed into a
 *   live-upsert-valid shape.
 */
export function repairNormalizedRetainedMixedPolicyConflictFacts(
  facts: readonly ProfileFactRecord[]
): ProfileFactRecord[] {
  const conflictGroups = collectMixedPolicyConflictActiveFactGroups(facts);
  if (conflictGroups.length === 0) {
    return [...facts];
  }

  const repairedFacts = new Map(facts.map((fact) => [fact.id, fact] as const));
  for (const group of conflictGroups) {
    const repairedGroup = replayMixedPolicyConflictGroup(group);
    for (const fact of group) {
      repairedFacts.set(fact.id, repairedGroup.get(fact.id) ?? fact);
    }
  }

  return facts.map((fact) => repairedFacts.get(fact.id) ?? fact);
}

/**
 * Collects malformed same-key retained conflicts whose active facts span multiple family
 * displacement policies.
 *
 * @param facts - Normalized retained facts.
 * @returns Active conflicting fact groups that need mixed-policy replay repair.
 */
function collectMixedPolicyConflictActiveFactGroups(
  facts: readonly ProfileFactRecord[]
): ProfileFactRecord[][] {
  const groups = new Map<string, ProfileFactRecord[]>();
  for (const fact of facts) {
    if (!isActiveRetainedFact(fact)) {
      continue;
    }
    const bucket = groups.get(fact.key) ?? [];
    bucket.push(fact);
    groups.set(fact.key, bucket);
  }

  return [...groups.values()].filter((group) => {
    const distinctValues = new Set(group.map((fact) => fact.value));
    if (distinctValues.size <= 1) {
      return false;
    }

    const families = new Set(
      group.map((fact) => inferGovernanceFamilyForNormalizedKey(fact.key, fact.value))
    );
    return families.size > 1;
  });
}

/**
 * Replays one mixed-policy active retained-fact conflict group into a live-upsert-valid shape.
 *
 * @param facts - Same-key different-value active retained facts with multiple inferred families.
 * @returns Per-fact repair map for the supplied group.
 */
function replayMixedPolicyConflictGroup(
  facts: readonly ProfileFactRecord[]
): Map<string, ProfileFactRecord> {
  const repairedFacts = new Map<string, ProfileFactRecord>();
  const activeFacts: ProfileFactRecord[] = [];

  for (const fact of [...facts].sort(compareRetainedMixedPolicyReplayOrder)) {
    const family = inferGovernanceFamilyForNormalizedKey(fact.key, fact.value);
    const displacementPolicy = getProfileMemoryFamilyRegistryEntry(family).displacementPolicy;
    const conflictDisposition = resolveRetainedConflictDisposition(
      displacementPolicy,
      fact.source
    );
    const conflictingActiveFacts = activeFacts.filter(
      (activeFact) => activeFact.key === fact.key && activeFact.value !== fact.value
    );

    if (conflictingActiveFacts.length === 0) {
      activeFacts.push(fact);
      repairedFacts.set(fact.id, fact);
      continue;
    }

    if (conflictDisposition === "replace") {
      const survivingActiveFacts = activeFacts.filter(
        (activeFact) => activeFact.key !== fact.key || activeFact.value === fact.value
      );
      for (const conflictingFact of conflictingActiveFacts) {
        repairedFacts.set(conflictingFact.id, closeRetainedConflictFact(conflictingFact, fact));
      }
      survivingActiveFacts.push(fact);
      activeFacts.splice(0, activeFacts.length, ...survivingActiveFacts);
      repairedFacts.set(fact.id, fact);
      continue;
    }

    const challengerFact =
      conflictDisposition === "preserve"
        ? downgradeRetainedPreserveConflictFact(fact)
        : fact;
    activeFacts.push(challengerFact);
    repairedFacts.set(fact.id, challengerFact);
  }

  return repairedFacts;
}

/**
 * Evaluates whether one normalized retained fact is still active for mixed-policy replay.
 *
 * @param fact - Normalized retained fact under evaluation.
 * @returns `true` when the fact remains active.
 */
function isActiveRetainedFact(fact: ProfileFactRecord): boolean {
  return fact.status !== "superseded" && fact.supersededAt === null;
}

type RetainedFactConflictDisposition = "replace" | "preserve" | "append";

/**
 * Mirrors live fact-lifecycle conflict disposition for one normalized retained fact.
 *
 * @param displacementPolicy - Family displacement policy for the fact under evaluation.
 * @param source - Canonical retained source string.
 * @returns Conflict disposition aligned to the live upsert seam.
 */
function resolveRetainedConflictDisposition(
  displacementPolicy: ProfileMemoryDisplacementPolicy,
  source: string
): RetainedFactConflictDisposition {
  if (source.trim().toLowerCase() === MEMORY_REVIEW_FACT_CORRECTION_SOURCE) {
    return "replace";
  }

  switch (displacementPolicy) {
    case "replace_authoritative_successor":
    case "resolution_only":
      return "replace";
    case "preserve_prior_on_conflict":
    case "not_applicable":
      return "preserve";
    case "append_multi_value":
      return "append";
  }
}

/**
 * Orders mixed-policy retained facts into one deterministic replay sequence.
 *
 * @param left - Left fact candidate.
 * @param right - Right fact candidate.
 * @returns Negative when `left` should replay before `right`.
 */
function compareRetainedMixedPolicyReplayOrder(
  left: ProfileFactRecord,
  right: ProfileFactRecord
): number {
  const lastUpdatedAtComparison =
    Date.parse(left.lastUpdatedAt) - Date.parse(right.lastUpdatedAt);
  if (lastUpdatedAtComparison !== 0) {
    return lastUpdatedAtComparison;
  }

  const observedAtComparison = Date.parse(left.observedAt) - Date.parse(right.observedAt);
  if (observedAtComparison !== 0) {
    return observedAtComparison;
  }

  return left.id.localeCompare(right.id);
}

/**
 * Closes one conflicting retained fact behind the canonical mixed-policy winner.
 *
 * @param fact - Conflicting active fact to close.
 * @param winner - Canonical winner that displaced the conflicting fact.
 * @returns Superseded conflicting fact.
 */
function closeRetainedConflictFact(
  fact: ProfileFactRecord,
  winner: ProfileFactRecord
): ProfileFactRecord {
  const closureBoundary = maxIsoTimestamp([
    fact.observedAt,
    fact.lastUpdatedAt,
    winner.lastUpdatedAt
  ]);
  return {
    ...fact,
    status: "superseded",
    supersededAt: closureBoundary,
    lastUpdatedAt: closureBoundary
  };
}

/**
 * Downgrades one preserve-disposition challenger back to active uncertain state.
 *
 * @param fact - Conflicting challenger that must not remain confirmed.
 * @returns Active uncertain challenger aligned to live preserve-prior behavior.
 */
function downgradeRetainedPreserveConflictFact(
  fact: ProfileFactRecord
): ProfileFactRecord {
  return {
    ...fact,
    status: "uncertain",
    confirmedAt: null,
    supersededAt: null
  };
}

/**
 * Returns the latest canonical ISO timestamp in one collection.
 *
 * @param values - Canonical ISO timestamps.
 * @returns Latest timestamp.
 */
function maxIsoTimestamp(values: readonly string[]): string {
  let winner = values[0]!;
  for (const value of values.slice(1)) {
    if (Date.parse(value) > Date.parse(winner)) {
      winner = value;
    }
  }
  return winner;
}
