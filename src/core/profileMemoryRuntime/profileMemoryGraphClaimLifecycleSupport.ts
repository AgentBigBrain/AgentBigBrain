/**
 * @fileoverview Fail-closed claim lifecycle normalization helpers for additive graph state.
 */

import type { ProfileMemoryGraphClaimRecord } from "./profileMemoryGraphContracts";
import { PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME } from "./profileMemoryGraphContracts";
import { rebuildProfileMemoryGraphEnvelope } from "./profileMemoryGraphStateSupport";

/**
 * Normalizes malformed active or inactive claim lifecycle boundaries during load normalization and
 * live graph writes.
 *
 * @param input - Canonical claim records plus one deterministic repair timestamp.
 * @returns Repaired claim records and whether any lifecycle payload changed.
 */
export function normalizeProfileMemoryGraphClaimLifecycles(input: {
  claims: readonly ProfileMemoryGraphClaimRecord[];
  recordedAt: string;
}): {
  nextClaims: ProfileMemoryGraphClaimRecord[];
  changed: boolean;
} {
  let changed = false;
  const nextClaims = input.claims
    .map((claim) => {
      const nextClaim = normalizeProfileMemoryGraphClaimLifecycleRecord({
        claim,
        recordedAt: input.recordedAt
      });
      if (nextClaim !== claim) {
        changed = true;
      }
      return nextClaim;
    })
    .sort(compareClaimRecords);

  return {
    nextClaims,
    changed
  };
}

/**
 * Repairs one claim record when active state and closure timestamps disagree.
 *
 * @param input - Candidate claim plus repair timestamp.
 * @returns Original claim when already canonical, otherwise one repaired envelope.
 */
function normalizeProfileMemoryGraphClaimLifecycleRecord(input: {
  claim: ProfileMemoryGraphClaimRecord;
  recordedAt: string;
}): ProfileMemoryGraphClaimRecord {
  const { payload } = input.claim;
  const isRedacted = payload.redactionState === "redacted";
  const nextStableRefId = isRedacted ? null : payload.stableRefId;
  const nextActive = isRedacted ? false : payload.active;
  const nextNormalizedValue = isRedacted ? null : payload.normalizedValue;
  const nextEntityRefIds = isRedacted ? [] : payload.entityRefIds;
  const nextClosureBoundary = nextActive
    ? null
    : selectClaimClosureBoundary({
        validTo: payload.validTo,
        endedAt: payload.endedAt,
        redactedAt: isRedacted ? payload.redactedAt ?? null : null,
        fallback: input.recordedAt
      });
  const nextValidTo = nextActive ? null : nextClosureBoundary;
  const nextEndedAt = nextActive ? null : nextClosureBoundary;
  const nextRedactedAt = isRedacted
    ? payload.redactedAt ?? nextClosureBoundary
    : payload.redactedAt;
  const nextSensitive = isRedacted ? true : payload.sensitive;

  if (
    nextStableRefId === payload.stableRefId &&
    nextActive === payload.active &&
    nextNormalizedValue === payload.normalizedValue &&
    arraysEqual(nextEntityRefIds, payload.entityRefIds) &&
    nextValidTo === payload.validTo &&
    nextEndedAt === payload.endedAt &&
    nextRedactedAt === payload.redactedAt &&
    nextSensitive === payload.sensitive
  ) {
    return input.claim;
  }

  return rebuildProfileMemoryGraphEnvelope({
    record: input.claim,
    schemaName: PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
    payload: {
      ...payload,
      stableRefId: nextStableRefId,
      active: nextActive,
      normalizedValue: nextNormalizedValue,
      entityRefIds: nextEntityRefIds,
      validTo: nextValidTo,
      endedAt: nextEndedAt,
      redactedAt: nextRedactedAt,
      sensitive: nextSensitive
    },
    fallbackCreatedAt: input.recordedAt
  });
}

/**
 * Selects one canonical closure boundary for inactive or redacted claims.
 *
 * @param input - Candidate closure timestamps plus deterministic fallback.
 * @returns Earliest surviving closure timestamp, or the fallback when none exist.
 */
function selectClaimClosureBoundary(input: {
  validTo: string | null;
  endedAt: string | null;
  redactedAt: string | null;
  fallback: string;
}): string {
  const candidates = [input.validTo, input.endedAt, input.redactedAt]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort((left, right) => left.localeCompare(right));
  return candidates[0] ?? input.fallback;
}

/**
 * Checks whether two bounded string arrays already match.
 *
 * @param left - Left candidate array.
 * @param right - Right candidate array.
 * @returns `true` when both arrays already match.
 */
function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Orders graph claims deterministically after lifecycle repair.
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
