/**
 * @fileoverview Focused helpers for fail-closed retained flat-fact deduplication.
 */

import type { ProfileFactRecord } from "../profileMemory";

/**
 * Orders retained fact statuses for duplicate-id winner selection.
 *
 * @param status - Canonical retained fact status.
 * @returns Higher value when the status should win duplicate-id ties.
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
 * Chooses the deterministic winner when two normalized retained facts share one canonical id.
 *
 * @param existing - Existing retained fact winner for the id.
 * @param candidate - New retained fact candidate for the same id.
 * @returns `true` when the candidate should replace the existing winner.
 */
function shouldReplaceNormalizedRetainedFact(
  existing: ProfileFactRecord,
  candidate: ProfileFactRecord
): boolean {
  const lastUpdatedComparison =
    Date.parse(candidate.lastUpdatedAt) - Date.parse(existing.lastUpdatedAt);
  if (lastUpdatedComparison !== 0) {
    return lastUpdatedComparison > 0;
  }

  const observedAtComparison =
    Date.parse(candidate.observedAt) - Date.parse(existing.observedAt);
  if (observedAtComparison !== 0) {
    return observedAtComparison > 0;
  }

  const statusComparison =
    factStatusPriority(candidate.status) - factStatusPriority(existing.status);
  if (statusComparison !== 0) {
    return statusComparison > 0;
  }

  if (candidate.confidence !== existing.confidence) {
    return candidate.confidence > existing.confidence;
  }

  const candidateAudit = candidate.mutationAudit ? 1 : 0;
  const existingAudit = existing.mutationAudit ? 1 : 0;
  if (candidateAudit !== existingAudit) {
    return candidateAudit > existingAudit;
  }

  return false;
}

/**
 * Dedupes normalized retained facts by canonical fact id.
 *
 * **Why it exists:**
 * Live fact upserts refresh one canonical fact record instead of keeping duplicate rows with the
 * same id, so encrypted reload should not let malformed retained duplicates surface twice on
 * compatibility reads or legacy graph repair.
 *
 * **What it talks to:**
 * - Uses only normalized `ProfileFactRecord` payloads that already passed semantic, provenance,
 *   lifecycle, and source-authority checks.
 *
 * @param facts - Normalized retained facts under evaluation.
 * @returns Canonical retained facts with one deterministic winner per fact id.
 */
export function dedupeNormalizedRetainedFacts(
  facts: readonly ProfileFactRecord[]
): ProfileFactRecord[] {
  const dedupedFacts = new Map<string, ProfileFactRecord>();
  for (const fact of facts) {
    const existing = dedupedFacts.get(fact.id);
    if (!existing || shouldReplaceNormalizedRetainedFact(existing, fact)) {
      dedupedFacts.set(fact.id, fact);
    }
  }
  return [...dedupedFacts.values()];
}

/**
 * Repairs malformed semantic-duplicate active retained facts that survived with different ids.
 *
 * **Why it exists:**
 * Live fact upserts already collapse same-key same-value active writes into one canonical active
 * fact plus superseded audit history, so encrypted reload should not keep multiple active rows for
 * the same current semantic fact just because malformed persisted state carried different ids.
 *
 * **What it talks to:**
 * - Uses only normalized `ProfileFactRecord` payloads that already passed semantic, provenance,
 *   lifecycle, sensitivity-floor, and source-authority checks.
 *
 * @param facts - Normalized retained facts under evaluation.
 * @returns Canonical retained facts with one active winner per same-key same-value group.
 */
export function repairNormalizedRetainedSemanticDuplicateFacts(
  facts: readonly ProfileFactRecord[]
): ProfileFactRecord[] {
  const duplicateGroups = collectSemanticDuplicateActiveFactGroups(facts);
  if (duplicateGroups.length === 0) {
    return [...facts];
  }

  const repairedFacts = new Map(facts.map((fact) => [fact.id, fact] as const));
  for (const group of duplicateGroups) {
    const winner = selectSemanticDuplicateFactWinner(group);
    const mergedWinner = mergeSemanticDuplicateFactWinner(group, winner);
    repairedFacts.set(mergedWinner.id, mergedWinner);

    for (const fact of group) {
      if (fact.id === mergedWinner.id) {
        continue;
      }
      repairedFacts.set(
        fact.id,
        closeSemanticDuplicateFact(fact, mergedWinner)
      );
    }
  }

  return facts.map((fact) => repairedFacts.get(fact.id) ?? fact);
}

/**
 * Collects malformed semantic-duplicate active retained-fact groups keyed by canonical key/value.
 *
 * @param facts - Normalized retained facts.
 * @returns Active same-key same-value fact groups that should collapse to one winner.
 */
function collectSemanticDuplicateActiveFactGroups(
  facts: readonly ProfileFactRecord[]
): ProfileFactRecord[][] {
  const groups = new Map<string, ProfileFactRecord[]>();
  for (const fact of facts) {
    if (!isSemanticDuplicateRepairCandidate(fact)) {
      continue;
    }
    const groupKey = [fact.key, fact.value].join("\u0000");
    const bucket = groups.get(groupKey) ?? [];
    bucket.push(fact);
    groups.set(groupKey, bucket);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

/**
 * Evaluates whether one retained fact belongs on the semantic-duplicate repair lane.
 *
 * @param fact - Normalized retained fact under evaluation.
 * @returns `true` when the fact remains active and eligible for repair.
 */
function isSemanticDuplicateRepairCandidate(fact: ProfileFactRecord): boolean {
  return fact.status !== "superseded" && fact.supersededAt === null;
}

/**
 * Selects the deterministic active winner from one semantic-duplicate retained-fact group.
 *
 * @param facts - Same-key same-value active retained facts.
 * @returns Canonical active winner.
 */
function selectSemanticDuplicateFactWinner(
  facts: readonly ProfileFactRecord[]
): ProfileFactRecord {
  let winner = facts[0]!;
  for (const fact of facts.slice(1)) {
    if (compareSemanticDuplicateFactPriority(fact, winner) > 0) {
      winner = fact;
    }
  }
  return winner;
}

/**
 * Compares two active semantic-duplicate facts for deterministic winner selection.
 *
 * @param left - Left fact candidate.
 * @param right - Right fact candidate.
 * @returns Positive when `left` should replace `right`.
 */
function compareSemanticDuplicateFactPriority(
  left: ProfileFactRecord,
  right: ProfileFactRecord
): number {
  const statusComparison = factStatusPriority(left.status) - factStatusPriority(right.status);
  if (statusComparison !== 0) {
    return statusComparison;
  }

  if (left.confidence !== right.confidence) {
    return left.confidence - right.confidence;
  }

  const observedAtComparison = Date.parse(left.observedAt) - Date.parse(right.observedAt);
  if (observedAtComparison !== 0) {
    return observedAtComparison;
  }

  const lastUpdatedAtComparison =
    Date.parse(left.lastUpdatedAt) - Date.parse(right.lastUpdatedAt);
  if (lastUpdatedAtComparison !== 0) {
    return lastUpdatedAtComparison;
  }

  const leftAudit = left.mutationAudit ? 1 : 0;
  const rightAudit = right.mutationAudit ? 1 : 0;
  if (leftAudit !== rightAudit) {
    return leftAudit - rightAudit;
  }

  return left.id.localeCompare(right.id);
}

/**
 * Merges bounded support from semantic-duplicate facts into the canonical active winner.
 *
 * @param facts - Same-key same-value active retained facts.
 * @param winner - Deterministic active winner.
 * @returns Merged active winner.
 */
function mergeSemanticDuplicateFactWinner(
  facts: readonly ProfileFactRecord[],
  winner: ProfileFactRecord
): ProfileFactRecord {
  const confirmedFacts = facts.filter((fact) => fact.status === "confirmed");
  const nextStatus: ProfileFactRecord["status"] =
    confirmedFacts.length > 0 ? "confirmed" : "uncertain";
  const nextMutationAudit = winner.mutationAudit ?? firstMutationAudit(facts);

  return {
    ...winner,
    sensitive: facts.some((fact) => fact.sensitive),
    status: nextStatus,
    confidence: Math.max(...facts.map((fact) => fact.confidence)),
    observedAt: minIsoTimestamp(facts.map((fact) => fact.observedAt)),
    confirmedAt:
      nextStatus === "confirmed"
        ? minIsoTimestamp(
          confirmedFacts.map((fact) => fact.confirmedAt ?? fact.lastUpdatedAt)
        )
        : null,
    supersededAt: null,
    lastUpdatedAt: maxIsoTimestamp(facts.map((fact) => fact.lastUpdatedAt)),
    mutationAudit: nextMutationAudit ?? undefined
  };
}

/**
 * Closes one malformed duplicate active fact behind the canonical semantic winner.
 *
 * @param fact - Duplicate active fact to close.
 * @param winner - Canonical active winner for the same semantic fact.
 * @returns Superseded duplicate fact.
 */
function closeSemanticDuplicateFact(
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
 * Returns the earliest canonical ISO timestamp in one collection.
 *
 * @param values - Canonical ISO timestamps.
 * @returns Earliest timestamp.
 */
function minIsoTimestamp(values: readonly string[]): string {
  let winner = values[0]!;
  for (const value of values.slice(1)) {
    if (Date.parse(value) < Date.parse(winner)) {
      winner = value;
    }
  }
  return winner;
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

/**
 * Returns the first available mutation-audit payload across one fact collection.
 *
 * @param facts - Retained facts under evaluation.
 * @returns First surviving mutation-audit payload, or `undefined`.
 */
function firstMutationAudit(
  facts: readonly ProfileFactRecord[]
): ProfileFactRecord["mutationAudit"] | undefined {
  for (const fact of facts) {
    if (fact.mutationAudit) {
      return fact.mutationAudit;
    }
  }
  return undefined;
}
