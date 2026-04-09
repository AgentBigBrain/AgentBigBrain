/**
 * @fileoverview Claim-successor pruning helpers for additive profile-memory graph state.
 */

import {
  PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME
} from "./profileMemoryGraphContracts";
import type {
  ProfileMemoryGraphClaimRecord
} from "./profileMemoryGraphContracts";
import { rebuildProfileMemoryGraphEnvelope } from "./profileMemoryGraphStateSupport";

/**
 * Prunes malformed `endedByClaimId` refs from retained graph claims.
 *
 * @param input - Canonical retained claims plus the deterministic repair timestamp.
 * @returns Canonical claims with bounded successor refs only.
 */
export function pruneProfileMemoryGraphClaimSuccessors(input: {
  claims: readonly ProfileMemoryGraphClaimRecord[];
  recordedAt: string;
}): {
  nextClaims: ProfileMemoryGraphClaimRecord[];
  changed: boolean;
} {
  const claimsById = new Map(
    input.claims.map((claim) => [claim.payload.claimId, claim] as const)
  );
  const nextClaims = input.claims.map((claim) =>
    pruneClaimSuccessor(claim, claimsById, input.recordedAt)
  );
  return {
    nextClaims,
    changed: nextClaims.some((claim, index) => claim !== input.claims[index])
  };
}

/**
 * Repairs one claim's successor ref when the retained value is malformed.
 *
 * @param claim - Canonical retained claim record.
 * @param claimsById - Surviving claim records by canonical id.
 * @param recordedAt - Deterministic repair timestamp.
 * @returns Original claim when unchanged, otherwise a repaired claim envelope.
 */
function pruneClaimSuccessor(
  claim: ProfileMemoryGraphClaimRecord,
  claimsById: ReadonlyMap<string, ProfileMemoryGraphClaimRecord>,
  recordedAt: string
): ProfileMemoryGraphClaimRecord {
  const endedByClaimId = normalizeEndedByClaimId(claim, claimsById);
  if (endedByClaimId === claim.payload.endedByClaimId) {
    return claim;
  }
  return rebuildProfileMemoryGraphEnvelope({
    record: claim,
    schemaName: PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
    payload: {
      ...claim.payload,
      endedByClaimId
    },
    fallbackCreatedAt: recordedAt
  });
}

/**
 * Normalizes one claim's bounded successor ref.
 *
 * @param claim - Canonical retained claim record.
 * @param claimsById - Surviving claim records by canonical id.
 * @returns Valid successor claim id, or `null` when the retained ref is malformed.
 */
function normalizeEndedByClaimId(
  claim: ProfileMemoryGraphClaimRecord,
  claimsById: ReadonlyMap<string, ProfileMemoryGraphClaimRecord>
): string | null {
  if (claim.payload.active) {
    return null;
  }
  const endedByClaimId = claim.payload.endedByClaimId;
  if (typeof endedByClaimId !== "string" || endedByClaimId.trim().length === 0) {
    return null;
  }
  if (endedByClaimId === claim.payload.claimId) {
    return null;
  }
  const successor = claimsById.get(endedByClaimId);
  if (!successor) {
    return null;
  }
  if (successor.payload.family !== claim.payload.family) {
    return null;
  }
  if (successor.payload.normalizedKey !== claim.payload.normalizedKey) {
    return null;
  }
  return endedByClaimId;
}
