/**
 * @fileoverview Derived index and read-model builders for graph-backed profile-memory state.
 */

import type {
  ProfileMemoryGraphClaimRecord,
  ProfileMemoryGraphEventRecord,
  ProfileMemoryGraphIndexStateV1,
  ProfileMemoryGraphReadModelV1,
  ProfileMemoryGraphSourceTier,
  ProfileMemoryMutationJournalStateV1
} from "./profileMemoryGraphContracts";
import { isProfileMemoryGraphClaimCurrentSurfaceEligible } from "./profileMemoryGraphClaimSurfaceEligibilitySupport";

/**
 * Creates one empty derived graph-index state.
 *
 * @returns Empty graph-index state.
 */
export function createEmptyProfileMemoryGraphIndexState(): ProfileMemoryGraphIndexStateV1 {
  return {
    schemaVersion: "v1",
    byEntityRefId: {},
    byFamily: {},
    validityWindow: [],
    bySourceTier: createEmptySourceTierBuckets(),
    activeClaimIds: []
  };
}

/**
 * Creates one empty derived graph read model.
 *
 * @returns Empty graph read model with watermark `0`.
 */
export function createEmptyProfileMemoryGraphReadModel(): ProfileMemoryGraphReadModelV1 {
  return {
    schemaVersion: "v1",
    watermark: 0,
    rebuiltAt: null,
    currentClaimIdsByKey: {},
    conflictingCurrentClaimIdsByKey: {},
    inventoryClaimIdsByFamily: {}
  };
}

/**
 * Rebuilds bounded derived indexes from canonical graph claim and event records.
 *
 * @param input - Canonical graph records to index.
 * @returns Rebuilt bounded index state.
 */
export function buildProfileMemoryGraphIndexState(input: {
  claims: readonly ProfileMemoryGraphClaimRecord[];
  events: readonly ProfileMemoryGraphEventRecord[];
}): ProfileMemoryGraphIndexStateV1 {
  const indexState = createEmptyProfileMemoryGraphIndexState();

  for (const claim of input.claims) {
    if (claim.payload.redactionState === "redacted") {
      continue;
    }
    const claimFamily = getNonEmptyGraphString(claim.payload.family);
    const claimKey = getNonEmptyGraphString(claim.payload.normalizedKey);
    if (claimFamily && claimKey) {
      indexByFamily(indexState.byFamily, claimFamily, claim.payload.claimId);
    }
    indexBySourceTier(indexState.bySourceTier, claim.payload.sourceTier, claim.payload.claimId);
    indexByEntityRefs(indexState.byEntityRefId, claim.payload.entityRefIds, claim.payload.claimId);
    indexState.validityWindow.push({
      recordType: "claim",
      recordId: claim.payload.claimId,
      validFrom: claim.payload.validFrom,
      validTo: claim.payload.validTo,
      active: claim.payload.active
    });
    if (claim.payload.active) {
      indexState.activeClaimIds.push(claim.payload.claimId);
    }
  }

  for (const event of input.events) {
    if (event.payload.redactionState === "redacted") {
      continue;
    }
    const eventFamily = getNonEmptyGraphString(event.payload.family);
    if (eventFamily) {
      indexByFamily(indexState.byFamily, eventFamily, event.payload.eventId);
    }
    indexBySourceTier(indexState.bySourceTier, event.payload.sourceTier, event.payload.eventId);
    indexByEntityRefs(indexState.byEntityRefId, event.payload.entityRefIds, event.payload.eventId);
    indexState.validityWindow.push({
      recordType: "event",
      recordId: event.payload.eventId,
      validFrom: event.payload.validFrom,
      validTo: event.payload.validTo,
      active: event.payload.validTo === null
    });
  }

  indexState.validityWindow.sort(compareValidityWindowEntries);
  indexState.activeClaimIds.sort();
  sortStringBucketRecord(indexState.byEntityRefId);
  sortStringBucketRecord(indexState.byFamily);
  sortStringBucketRecord(indexState.bySourceTier);

  return indexState;
}

/**
 * Rebuilds one bounded current-state and inventory read model from canonical claim records.
 *
 * @param input - Canonical claim records plus journal watermark state.
 * @returns Rebuilt bounded read model.
 */
export function buildProfileMemoryGraphReadModel(input: {
  claims: readonly ProfileMemoryGraphClaimRecord[];
  mutationJournal: ProfileMemoryMutationJournalStateV1;
  rebuiltAt: string | null;
}): ProfileMemoryGraphReadModelV1 {
  const readModel = createEmptyProfileMemoryGraphReadModel();
  readModel.watermark = Math.max(0, input.mutationJournal.nextWatermark - 1);
  readModel.rebuiltAt = input.rebuiltAt;

  const currentClaimIdsByKey = new Map<string, string[]>();
  for (const claim of input.claims) {
    if (!claim.payload.active || claim.payload.redactionState === "redacted") {
      continue;
    }
    const normalizedKey = getNonEmptyGraphString(claim.payload.normalizedKey);
    const family = getNonEmptyGraphString(claim.payload.family);
    const normalizedValue = getNonEmptyGraphString(claim.payload.normalizedValue);
    if (
      !normalizedKey ||
      !family ||
      !normalizedValue ||
      !isProfileMemoryGraphClaimCurrentSurfaceEligible(claim)
    ) {
      continue;
    }
    const keyClaimIds = currentClaimIdsByKey.get(normalizedKey) ?? [];
    keyClaimIds.push(claim.payload.claimId);
    currentClaimIdsByKey.set(normalizedKey, keyClaimIds);
    const existingFamilyIds = readModel.inventoryClaimIdsByFamily[family] ?? [];
    existingFamilyIds.push(claim.payload.claimId);
    readModel.inventoryClaimIdsByFamily[family] = existingFamilyIds;
  }

  for (const [key, claimIds] of currentClaimIdsByKey.entries()) {
    claimIds.sort((left, right) => left.localeCompare(right));
    if (claimIds.length === 1) {
      readModel.currentClaimIdsByKey[key] = claimIds[0]!;
      continue;
    }
    readModel.conflictingCurrentClaimIdsByKey[key] = claimIds;
  }

  sortStringBucketRecord(readModel.conflictingCurrentClaimIdsByKey);
  sortStringBucketRecord(readModel.inventoryClaimIdsByFamily);
  return readModel;
}

/**
 * Creates empty bounded source-tier buckets for derived graph indexes.
 *
 * @returns Empty source-tier bucket record.
 */
function createEmptySourceTierBuckets(): Record<ProfileMemoryGraphSourceTier, string[]> {
  return {
    explicit_user_statement: [],
    validated_structured_candidate: [],
    reconciliation_or_projection: [],
    assistant_inference: []
  };
}

/**
 * Adds one record ID to each entity-ref bucket referenced by one graph record.
 *
 * @param buckets - Mutable entity-ref buckets.
 * @param entityRefIds - Entity refs carried by the record.
 * @param recordId - Canonical graph record ID to index.
 */
function indexByEntityRefs(
  buckets: Record<string, string[]>,
  entityRefIds: readonly string[],
  recordId: string
): void {
  const seenEntityRefIds = new Set<string>();
  for (const entityRefId of entityRefIds) {
    if (seenEntityRefIds.has(entityRefId)) {
      continue;
    }
    seenEntityRefIds.add(entityRefId);
    const bucket = buckets[entityRefId] ?? [];
    bucket.push(recordId);
    buckets[entityRefId] = bucket;
  }
}

/**
 * Adds one record ID to the bounded family bucket for one graph record.
 *
 * @param buckets - Mutable family buckets.
 * @param family - Canonical family key for the record.
 * @param recordId - Canonical graph record ID to index.
 */
function indexByFamily(
  buckets: Record<string, string[]>,
  family: string,
  recordId: string
): void {
  const bucket = buckets[family] ?? [];
  bucket.push(recordId);
  buckets[family] = bucket;
}

/**
 * Adds one record ID to the bounded source-tier bucket for one graph record.
 *
 * @param buckets - Mutable source-tier buckets.
 * @param sourceTier - Source tier for the graph record.
 * @param recordId - Canonical graph record ID to index.
 */
function indexBySourceTier(
  buckets: Record<ProfileMemoryGraphSourceTier, string[]>,
  sourceTier: ProfileMemoryGraphSourceTier,
  recordId: string
): void {
  buckets[sourceTier].push(recordId);
}

/**
 * Orders derived validity-window entries deterministically for persistence parity.
 *
 * @param left - Left validity-window entry.
 * @param right - Right validity-window entry.
 * @returns Stable ordering result.
 */
function compareValidityWindowEntries(
  left: ProfileMemoryGraphIndexStateV1["validityWindow"][number],
  right: ProfileMemoryGraphIndexStateV1["validityWindow"][number]
): number {
  const leftStart = left.validFrom ?? "";
  const rightStart = right.validFrom ?? "";
  if (leftStart !== rightStart) {
    return leftStart.localeCompare(rightStart);
  }
  return left.recordId.localeCompare(right.recordId);
}

/**
 * Sorts every bucket in one string-array record in place for deterministic persistence.
 *
 * @param record - Mutable bucket record to sort.
 */
function sortStringBucketRecord(record: Record<string, string[]>): void {
  for (const value of Object.values(record)) {
    value.sort();
  }
}

/**
 * Returns one trimmed non-empty graph string or `null` when the candidate is blank.
 *
 * @param value - Candidate persisted graph string.
 * @returns Trimmed canonical string or `null`.
 */
function getNonEmptyGraphString(value: string | null): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
