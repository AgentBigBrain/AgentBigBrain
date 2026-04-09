/**
 * @fileoverview Fail-closed authoritative active-claim conflict repair for additive profile-memory graph state.
 */

import { createSchemaEnvelopeV1 } from "../schemaEnvelope";
import {
  PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
  type ProfileMemoryGraphClaimRecord
} from "./profileMemoryGraphContracts";
import { isProfileMemoryGraphClaimCurrentSurfaceEligible } from "./profileMemoryGraphClaimSurfaceEligibilitySupport";
import { getProfileMemoryFamilyRegistryEntry } from "./profileMemoryFamilyRegistry";
import { inferGovernanceFamilyForNormalizedKey } from "./profileMemoryGovernanceFamilyInference";
import type { ProfileMemoryDisplacementPolicy } from "./profileMemoryTruthGovernanceContracts";

/**
 * Repairs malformed same-key active-claim conflicts when at least one surviving claim belongs to
 * an authoritative replacement family.
 *
 * **Why it exists:**
 * Live fact upserts and graph current-claim reconciliation do not keep multiple active current
 * claims alive for replace-authoritative or resolution-only families, but older retained graph
 * state can still arrive with same-key different-value active claims. This bounded repair closes
 * the losers fail-closed while leaving preserve-prior ambiguity untouched.
 *
 * **What it talks to:**
 * - Uses `createSchemaEnvelopeV1` (import `createSchemaEnvelopeV1`) from `../schemaEnvelope`.
 * - Uses `getProfileMemoryFamilyRegistryEntry` (import `getProfileMemoryFamilyRegistryEntry`) from
 *   `./profileMemoryFamilyRegistry`.
 * - Uses `inferGovernanceFamilyForNormalizedKey` (import
 *   `inferGovernanceFamilyForNormalizedKey`) from
 *   `./profileMemoryGovernanceFamilyInference`.
 * - Uses graph claim contracts from `./profileMemoryGraphContracts`.
 *
 * @param input - Canonical active claim lane plus one deterministic repair timestamp.
 * @returns Repaired claims and whether authoritative conflict repair changed anything.
 */
export function repairProfileMemoryGraphAuthoritativeActiveClaimConflicts(input: {
  claims: readonly ProfileMemoryGraphClaimRecord[];
  recordedAt: string;
}): {
  nextClaims: ProfileMemoryGraphClaimRecord[];
  changed: boolean;
} {
  const conflictGroups = collectAuthoritativeConflictActiveClaimGroups(input.claims);
  if (conflictGroups.length === 0) {
    return {
      nextClaims: [...input.claims],
      changed: false
    };
  }

  const repairedClaimMap = new Map(
    input.claims.map((claim) => [claim.payload.claimId, claim] as const)
  );
  let changed = false;

  for (const group of conflictGroups) {
    const winner = selectAuthoritativeConflictWinner(group);
    for (const claim of group) {
      if (claim.payload.claimId === winner.payload.claimId) {
        continue;
      }
      const closedClaim = closeAuthoritativeConflictClaim({
        claim,
        winner,
        recordedAt: input.recordedAt
      });
      if (!graphClaimRecordsEqual(closedClaim, claim)) {
        repairedClaimMap.set(closedClaim.payload.claimId, closedClaim);
        changed = true;
      }
    }
  }

  return {
    nextClaims: [...repairedClaimMap.values()].sort(compareClaimRecords),
    changed
  };
}

/**
 * Collects malformed active same-key different-value claim groups that should fail closed behind
 * one authoritative winner.
 *
 * **Why it exists:**
 * The repair lane must stay narrower than general read-model suppression. It only touches groups
 * where at least one claim belongs to a family whose live semantics replace conflicting current
 * truth instead of preserving ambiguity.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param claims - Canonical graph claim lane after metadata, timestamp, and lifecycle repair.
 * @returns Active authoritative conflict groups keyed by normalized current-state key.
 */
function collectAuthoritativeConflictActiveClaimGroups(
  claims: readonly ProfileMemoryGraphClaimRecord[]
): ProfileMemoryGraphClaimRecord[][] {
  const groups = new Map<string, ProfileMemoryGraphClaimRecord[]>();
  for (const claim of claims) {
    if (!isAuthoritativeConflictRepairCandidate(claim)) {
      continue;
    }
    const bucket = groups.get(claim.payload.normalizedKey) ?? [];
    bucket.push(claim);
    groups.set(claim.payload.normalizedKey, bucket);
  }

  return [...groups.values()].filter(
    (group) =>
      new Set(group.map((claim) => claim.payload.normalizedValue)).size > 1 &&
      group.some((claim) => isAuthoritativeConflictFamily(claim))
  );
}

/**
 * Checks whether one claim belongs on the authoritative conflict-repair lane.
 *
 * **Why it exists:**
 * Repair should only touch active, non-redacted claims that still belong on the bounded current or
 * canonical end-state surface. Blank-semantic or source-authority-invalid claims already fail
 * closed on that surface and should remain canonical-only.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param claim - Candidate graph claim record.
 * @returns `true` when the claim can participate in authoritative conflict repair.
 */
function isAuthoritativeConflictRepairCandidate(
  claim: ProfileMemoryGraphClaimRecord
): boolean {
  return (
    claim.payload.active &&
    claim.payload.redactionState !== "redacted" &&
    isProfileMemoryGraphClaimCurrentSurfaceEligible(claim)
  );
}

/**
 * Evaluates whether one active claim belongs to a family that replaces conflicting current truth.
 *
 * **Why it exists:**
 * Replace-authoritative and resolution-only families can repair retained active conflicts without
 * needing flat-fact status or confidence semantics, while preserve-prior ambiguity must remain
 * visible to the read-model suppression layer.
 *
 * **What it talks to:**
 * - Uses `inferGovernanceFamilyForNormalizedKey` (import
 *   `inferGovernanceFamilyForNormalizedKey`) from
 *   `./profileMemoryGovernanceFamilyInference`.
 * - Uses `getProfileMemoryFamilyRegistryEntry` (import `getProfileMemoryFamilyRegistryEntry`) from
 *   `./profileMemoryFamilyRegistry`.
 *
 * @param claim - Active graph claim candidate.
 * @returns `true` when the inferred family uses authoritative replacement semantics.
 */
function isAuthoritativeConflictFamily(claim: ProfileMemoryGraphClaimRecord): boolean {
  const displacementPolicy = resolveClaimDisplacementPolicy(claim);
  return (
    displacementPolicy === "replace_authoritative_successor" ||
    displacementPolicy === "resolution_only"
  );
}

/**
 * Selects the deterministic authoritative winner from one active same-key different-value claim
 * group.
 *
 * **Why it exists:**
 * Retained graph repair must not depend on array order. Resolution-only or replace-authoritative
 * families outrank preserve-prior challengers, then the newest surviving authoritative claim wins.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param claims - Malformed same-key active claims containing at least one authoritative family.
 * @returns Canonical active winner.
 */
function selectAuthoritativeConflictWinner(
  claims: readonly ProfileMemoryGraphClaimRecord[]
): ProfileMemoryGraphClaimRecord {
  let winner = claims[0]!;
  for (const claim of claims.slice(1)) {
    if (compareAuthoritativeConflictPriority(claim, winner) > 0) {
      winner = claim;
    }
  }
  return winner;
}

/**
 * Compares two active conflicting claims for authoritative winner selection.
 *
 * **Why it exists:**
 * Winner selection must prefer claims whose inferred family replaces conflicting current truth,
 * while still staying deterministic when multiple authoritative claims survive one key.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param left - Left conflicting claim.
 * @param right - Right conflicting claim.
 * @returns Positive when `left` should replace `right` as the canonical winner.
 */
function compareAuthoritativeConflictPriority(
  left: ProfileMemoryGraphClaimRecord,
  right: ProfileMemoryGraphClaimRecord
): number {
  const leftPolicyPriority = authoritativeDisplacementPolicyPriority(
    resolveClaimDisplacementPolicy(left)
  );
  const rightPolicyPriority = authoritativeDisplacementPolicyPriority(
    resolveClaimDisplacementPolicy(right)
  );
  if (leftPolicyPriority !== rightPolicyPriority) {
    return leftPolicyPriority - rightPolicyPriority;
  }

  const leftFreshness = claimFreshnessPriority(left);
  const rightFreshness = claimFreshnessPriority(right);
  if (leftFreshness !== rightFreshness) {
    return leftFreshness.localeCompare(rightFreshness);
  }
  if (left.createdAt !== right.createdAt) {
    return left.createdAt.localeCompare(right.createdAt);
  }
  if (left.hash !== right.hash) {
    return left.hash.localeCompare(right.hash);
  }
  return left.payload.claimId.localeCompare(right.payload.claimId);
}

/**
 * Resolves the conflict-relevant displacement policy for one active claim.
 *
 * **Why it exists:**
 * Retained graph claim payloads may carry older or mixed family labels, so authoritative repair
 * should infer the code-owned family from the normalized key/value pair the same way live truth
 * governance does.
 *
 * **What it talks to:**
 * - Uses `inferGovernanceFamilyForNormalizedKey` (import
 *   `inferGovernanceFamilyForNormalizedKey`) from
 *   `./profileMemoryGovernanceFamilyInference`.
 * - Uses `getProfileMemoryFamilyRegistryEntry` (import `getProfileMemoryFamilyRegistryEntry`) from
 *   `./profileMemoryFamilyRegistry`.
 *
 * @param claim - Active graph claim candidate.
 * @returns Code-owned displacement policy for that claim's inferred family.
 */
function resolveClaimDisplacementPolicy(
  claim: ProfileMemoryGraphClaimRecord
): ProfileMemoryDisplacementPolicy {
  const family = inferGovernanceFamilyForNormalizedKey(
    claim.payload.normalizedKey,
    claim.payload.normalizedValue ?? ""
  );
  return getProfileMemoryFamilyRegistryEntry(family).displacementPolicy;
}

/**
 * Ranks displacement policies for authoritative current-claim repair.
 *
 * **Why it exists:**
 * Resolution-only end-state claims should outrank replace-authoritative claims, and both should
 * outrank preserve-prior or append semantics when one malformed mixed-policy group survives load.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param displacementPolicy - Conflict-relevant family displacement policy.
 * @returns Numeric winner priority.
 */
function authoritativeDisplacementPolicyPriority(
  displacementPolicy: ProfileMemoryDisplacementPolicy
): number {
  switch (displacementPolicy) {
    case "resolution_only":
      return 3;
    case "replace_authoritative_successor":
      return 2;
    default:
      return 1;
  }
}

/**
 * Closes one malformed conflicting active claim behind the canonical authoritative winner.
 *
 * **Why it exists:**
 * Repairing authoritative conflicts should preserve the losing claim as bounded audit history
 * instead of deleting it, while keeping closure timestamps monotonic even when the winner is older
 * than a malformed challenger.
 *
 * **What it talks to:**
 * - Uses `createSchemaEnvelopeV1` (import `createSchemaEnvelopeV1`) from `../schemaEnvelope`.
 * - Uses `PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME` (import
 *   `PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME`) from `./profileMemoryGraphContracts`.
 * - Uses local helpers within this module.
 *
 * @param input - Losing claim, chosen winner, and deterministic repair timestamp.
 * @returns Closed conflicting claim record.
 */
function closeAuthoritativeConflictClaim(input: {
  claim: ProfileMemoryGraphClaimRecord;
  winner: ProfileMemoryGraphClaimRecord;
  recordedAt: string;
}): ProfileMemoryGraphClaimRecord {
  const closureBoundary = maxIsoTimestamp([
    input.claim.payload.validFrom,
    input.claim.payload.assertedAt,
    input.winner.payload.validFrom,
    input.winner.payload.assertedAt,
    input.recordedAt
  ]);
  return createSchemaEnvelopeV1(
    PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
    {
      ...input.claim.payload,
      active: false,
      validTo: input.claim.payload.validTo ?? closureBoundary,
      endedAt: input.claim.payload.endedAt ?? closureBoundary,
      endedByClaimId: input.winner.payload.claimId
    },
    safeIsoOrFallback(input.claim.createdAt, input.recordedAt)
  );
}

/**
 * Builds one comparable freshness priority for a graph claim.
 *
 * **Why it exists:**
 * Authoritative conflict repair should agree with the semantic-duplicate claim lane on what counts
 * as the newest surviving claim semantics before it falls back to envelope metadata.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param claim - Active graph claim candidate.
 * @returns Comparable freshness priority string.
 */
function claimFreshnessPriority(claim: ProfileMemoryGraphClaimRecord): string {
  return maxIsoTimestamp([claim.payload.validFrom, claim.payload.assertedAt]);
}

/**
 * Returns the latest usable ISO timestamp from one bounded candidate list.
 *
 * **Why it exists:**
 * Conflict repair must not move closure or freshness boundaries backward just because one retained
 * claim omitted a timestamp or carried malformed time text.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param values - Candidate timestamp values.
 * @returns Latest valid ISO timestamp, or the empty string when none are usable.
 */
function maxIsoTimestamp(values: readonly (string | null | undefined)[]): string {
  let winner = "";
  for (const value of values) {
    const normalized = safeIsoOrFallback(value, "");
    if (normalized.length > 0 && normalized.localeCompare(winner) > 0) {
      winner = normalized;
    }
  }
  return winner;
}

/**
 * Orders graph claims deterministically after authoritative conflict repair.
 *
 * **Why it exists:**
 * Normalization should emit one stable persisted claim order regardless of which conflict group
 * repaired during this load.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
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
 * Compares two claim records for structural equality without relying on object identity.
 *
 * **Why it exists:**
 * The repair path only wants to report change when the canonical claim contents actually differ.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
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
 * Coerces one timestamp candidate to canonical ISO format with a caller-supplied fallback.
 *
 * **Why it exists:**
 * Authoritative conflict repair must tolerate malformed retained envelope timestamps without
 * throwing or inventing a non-deterministic replacement time.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param value - Unknown timestamp candidate.
 * @param fallback - Fallback ISO timestamp.
 * @returns Valid ISO timestamp string or the fallback when invalid.
 */
function safeIsoOrFallback(value: unknown, fallback: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return Number.isFinite(Date.parse(trimmed))
    ? new Date(Date.parse(trimmed)).toISOString()
    : fallback;
}
