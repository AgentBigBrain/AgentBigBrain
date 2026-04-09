/**
 * @fileoverview Focused helpers for retained active-fact conflict repair under encrypted reload.
 */

import type { ProfileFactRecord } from "../profileMemory";
import { getProfileMemoryFamilyRegistryEntry } from "./profileMemoryFamilyRegistry";
import { inferGovernanceFamilyForNormalizedKey } from "./profileMemoryGovernanceFamilyInference";

/**
 * Repairs malformed active same-key different-value retained facts for replace-only families.
 *
 * **Why it exists:**
 * Live fact upserts on replace-authoritative families keep one active winner and supersede prior
 * conflicting values, so encrypted reload should not keep malformed multiple active current facts
 * alive for families whose lifecycle never preserves conflicting winners.
 *
 * **What it talks to:**
 * - Uses `inferGovernanceFamilyForNormalizedKey` (import) from
 *   `./profileMemoryGovernanceFamilyInference`.
 * - Uses `getProfileMemoryFamilyRegistryEntry` (import) from `./profileMemoryFamilyRegistry`.
 * - Uses only normalized `ProfileFactRecord` payloads that already passed semantic, provenance,
 *   lifecycle, sensitivity-floor, and source-authority checks.
 *
 * @param facts - Normalized retained facts under evaluation.
 * @returns Canonical retained facts with one active winner for replace-only conflicting groups.
 */
export function repairNormalizedRetainedReplaceConflictFacts(
  facts: readonly ProfileFactRecord[]
): ProfileFactRecord[] {
  const conflictGroups = collectReplaceConflictActiveFactGroups(facts);
  if (conflictGroups.length === 0) {
    return [...facts];
  }

  const repairedFacts = new Map(facts.map((fact) => [fact.id, fact] as const));
  for (const group of conflictGroups) {
    const winner = selectRetainedReplaceConflictWinner(group);
    repairedFacts.set(winner.id, winner);

    for (const fact of group) {
      if (fact.id === winner.id) {
        continue;
      }
      repairedFacts.set(fact.id, closeRetainedConflictFact(fact, winner));
    }
  }

  return facts.map((fact) => repairedFacts.get(fact.id) ?? fact);
}

/**
 * Repairs malformed preserve-prior retained conflicts that still carry multiple confirmed winners.
 *
 * **Why it exists:**
 * Live fact upserts on preserve-prior families keep the incumbent winner confirmed and store
 * conflicting challengers as active but uncertain, so encrypted reload should not leave multiple
 * confirmed winners alive for one preserved current-truth lane.
 *
 * **What it talks to:**
 * - Uses `inferGovernanceFamilyForNormalizedKey` (import) from
 *   `./profileMemoryGovernanceFamilyInference`.
 * - Uses `getProfileMemoryFamilyRegistryEntry` (import) from `./profileMemoryFamilyRegistry`.
 * - Uses only normalized `ProfileFactRecord` payloads that already passed semantic, provenance,
 *   lifecycle, sensitivity-floor, and source-authority checks.
 *
 * @param facts - Normalized retained facts under evaluation.
 * @returns Canonical retained facts with one confirmed incumbent per preserve-prior conflict
 *   group.
 */
export function repairNormalizedRetainedPreserveConflictFacts(
  facts: readonly ProfileFactRecord[]
): ProfileFactRecord[] {
  const conflictGroups = collectPreserveConflictConfirmedGroups(facts);
  if (conflictGroups.length === 0) {
    return [...facts];
  }

  const repairedFacts = new Map(facts.map((fact) => [fact.id, fact] as const));
  for (const group of conflictGroups) {
    const incumbent = selectRetainedPreserveConflictIncumbent(group);
    repairedFacts.set(incumbent.id, incumbent);

    for (const fact of group) {
      if (fact.id === incumbent.id || fact.status !== "confirmed") {
        continue;
      }
      repairedFacts.set(fact.id, downgradeRetainedPreserveConflictFact(fact));
    }
  }

  return facts.map((fact) => repairedFacts.get(fact.id) ?? fact);
}

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
 * **What it talks to:**
 * - Uses `inferGovernanceFamilyForNormalizedKey` (import) from
 *   `./profileMemoryGovernanceFamilyInference`.
 * - Uses `getProfileMemoryFamilyRegistryEntry` (import) from `./profileMemoryFamilyRegistry`.
 * - Mirrors the conflict disposition rules from the live fact-lifecycle seam, including review
 *   correction override.
 *
 * @param facts - Normalized retained facts under evaluation.
 * @returns Canonical retained facts with mixed-policy active conflicts replayed into a
 *   live-upsert-valid shape.
 */
/**
 * Collects malformed active same-key different-value groups for replace-only retained families.
 *
 * @param facts - Normalized retained facts.
 * @returns Active conflicting fact groups that should collapse to one winner.
 */
function collectReplaceConflictActiveFactGroups(
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
    if (families.size !== 1) {
      return false;
    }
    const family = [...families][0]!;
    const displacementPolicy = getProfileMemoryFamilyRegistryEntry(family).displacementPolicy;
    return displacementPolicy === "replace_authoritative_successor" ||
      displacementPolicy === "resolution_only";
  });
}

/**
 * Collects preserve-prior retained conflict groups that still carry multiple confirmed winners.
 *
 * @param facts - Normalized retained facts.
 * @returns Preserve-prior conflict groups that need one deterministic confirmed incumbent.
 */
function collectPreserveConflictConfirmedGroups(
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
    if (families.size !== 1) {
      return false;
    }
    const family = [...families][0]!;
    const displacementPolicy = getProfileMemoryFamilyRegistryEntry(family).displacementPolicy;
    if (displacementPolicy !== "preserve_prior_on_conflict") {
      return false;
    }
    return group.filter((fact) => fact.status === "confirmed").length > 1;
  });
}

/**
 * Evaluates whether one retained fact remains active for conflict repair.
 *
 * @param fact - Normalized retained fact under evaluation.
 * @returns `true` when the fact is active.
 */
function isActiveRetainedFact(fact: ProfileFactRecord): boolean {
  return fact.status !== "superseded" && fact.supersededAt === null;
}

/**
 * Selects the deterministic winner from one replace-only active retained-fact conflict group.
 *
 * @param facts - Same-key different-value active retained facts on a replace-only family.
 * @returns Canonical active winner.
 */
function selectRetainedReplaceConflictWinner(
  facts: readonly ProfileFactRecord[]
): ProfileFactRecord {
  let winner = facts[0]!;
  for (const fact of facts.slice(1)) {
    if (compareRetainedReplaceConflictPriority(fact, winner) > 0) {
      winner = fact;
    }
  }
  return winner;
}

/**
 * Selects the deterministic confirmed incumbent from one preserve-prior retained conflict group.
 *
 * @param facts - Same-key different-value active retained facts on a preserve-prior family.
 * @returns Confirmed incumbent that should remain confirmed after repair.
 */
function selectRetainedPreserveConflictIncumbent(
  facts: readonly ProfileFactRecord[]
): ProfileFactRecord {
  const confirmedFacts = facts.filter((fact) => fact.status === "confirmed");
  let incumbent = confirmedFacts[0]!;
  for (const fact of confirmedFacts.slice(1)) {
    if (compareRetainedPreserveConflictPriority(fact, incumbent) > 0) {
      incumbent = fact;
    }
  }
  return incumbent;
}

/**
 * Compares two conflicting active retained facts for replace-only family winner selection.
 *
 * @param left - Left fact candidate.
 * @param right - Right fact candidate.
 * @returns Positive when `left` should replace `right`.
 */
function compareRetainedReplaceConflictPriority(
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

  const statusComparison = factStatusPriority(left.status) - factStatusPriority(right.status);
  if (statusComparison !== 0) {
    return statusComparison;
  }

  if (left.confidence !== right.confidence) {
    return left.confidence - right.confidence;
  }

  const leftAudit = left.mutationAudit ? 1 : 0;
  const rightAudit = right.mutationAudit ? 1 : 0;
  if (leftAudit !== rightAudit) {
    return leftAudit - rightAudit;
  }

  return left.id.localeCompare(right.id);
}

/**
 * Compares two confirmed preserve-prior conflict facts for incumbent selection.
 *
 * @param left - Left fact candidate.
 * @param right - Right fact candidate.
 * @returns Positive when `left` should remain the confirmed incumbent.
 */
function compareRetainedPreserveConflictPriority(
  left: ProfileFactRecord,
  right: ProfileFactRecord
): number {
  const confirmedAtComparison =
    Date.parse(right.confirmedAt ?? right.lastUpdatedAt) -
    Date.parse(left.confirmedAt ?? left.lastUpdatedAt);
  if (confirmedAtComparison !== 0) {
    return confirmedAtComparison;
  }

  const observedAtComparison = Date.parse(right.observedAt) - Date.parse(left.observedAt);
  if (observedAtComparison !== 0) {
    return observedAtComparison;
  }

  const lastUpdatedAtComparison =
    Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt);
  if (lastUpdatedAtComparison !== 0) {
    return lastUpdatedAtComparison;
  }

  if (left.confidence !== right.confidence) {
    return left.confidence - right.confidence;
  }

  const leftAudit = left.mutationAudit ? 1 : 0;
  const rightAudit = right.mutationAudit ? 1 : 0;
  if (leftAudit !== rightAudit) {
    return leftAudit - rightAudit;
  }

  return right.id.localeCompare(left.id);
}


/**
 * Orders retained fact statuses for deterministic retained-conflict repair.
 *
 * @param status - Canonical retained fact status.
 * @returns Higher value when the status should win a deterministic tie.
 */
function factStatusPriority(status: ProfileFactRecord["status"]): number {
  switch (status) {
    case "confirmed":
      return 3;
    case "uncertain":
      return 2;
    case "superseded":
      return 1;
  }
}

/**
 * Closes one malformed conflicting active fact behind the canonical retained winner.
 *
 * @param fact - Conflicting active fact to close.
 * @param winner - Canonical active winner for the same key.
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
 * Downgrades one malformed preserve-prior confirmed challenger back to an active uncertain fact.
 *
 * @param fact - Confirmed challenger that should remain active but not confirmed.
 * @returns Active uncertain challenger aligned to preserve-prior live upsert behavior.
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
