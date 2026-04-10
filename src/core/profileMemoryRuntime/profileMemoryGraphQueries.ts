/**
 * @fileoverview Stable-ref attachment and grouping helpers for graph-backed personal-memory identity.
 */

import type {
  ProfileMemoryGraphClaimRecord,
  ProfileMemoryGraphEventRecord,
  ProfileMemoryGraphObservationRecord,
  ProfileMemoryGraphStableRefResolution,
  ProfileMemoryGraphState
} from "./profileMemoryGraphContracts";
import {
  PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
  PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME,
  PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME
} from "./profileMemoryGraphContracts";
import { isProfileMemoryGraphClaimCurrentSurfaceEligible } from "./profileMemoryGraphClaimSurfaceEligibilitySupport";
import { rebuildProfileMemoryGraphEnvelope } from "./profileMemoryGraphStateSupport";

const PROFILE_MEMORY_SELF_STABLE_REF_ID = "stable_self_profile_owner";
const PROFILE_MEMORY_CONTACT_STABLE_REF_PREFIX = "stable_contact_", PROFILE_MEMORY_QUARANTINE_STABLE_REF_PREFIX = "stable_quarantine_";

export interface ProfileMemoryGraphStableRefGroup {
  stableRefId: string;
  resolution: ProfileMemoryGraphStableRefResolution;
  observationIds: string[];
  claimIds: string[];
  eventIds: string[];
  entityRefIds: string[];
  families: string[];
}

export interface ProfileMemoryGraphStableRefAttachmentResult {
  nextObservations: ProfileMemoryGraphObservationRecord[];
  nextClaims: ProfileMemoryGraphClaimRecord[];
  nextEvents: ProfileMemoryGraphEventRecord[];
  changed: boolean;
}

interface MutableStableRefGroup {
  stableRefId: string;
  observationIds: Set<string>;
  claimIds: Set<string>;
  eventIds: Set<string>;
  entityRefIds: Set<string>;
  families: Set<string>;
}

/** Returns the canonical stable ref id for the profile owner. */
export function getProfileMemorySelfStableRefId(): string {
  return PROFILE_MEMORY_SELF_STABLE_REF_ID;
}
/** Builds a provisional stable ref id for a normalized contact token. */
export function buildProfileMemoryContactStableRefId(
  contactToken: string
): string | null {
  const normalizedContactToken = normalizeContactToken(contactToken);
  return normalizedContactToken === null
    ? null
    : `${PROFILE_MEMORY_CONTACT_STABLE_REF_PREFIX}${normalizedContactToken}`;
}
/** Reattaches stable refs across touched graph records after canonical normalization. */
export function attachProfileMemoryGraphStableRefs(input: {
  observations: readonly ProfileMemoryGraphObservationRecord[];
  claims: readonly ProfileMemoryGraphClaimRecord[];
  events: readonly ProfileMemoryGraphEventRecord[];
  touchedObservationIds: readonly string[];
  touchedClaimIds: readonly string[];
  touchedEventIds: readonly string[];
  recordedAt: string;
}): ProfileMemoryGraphStableRefAttachmentResult {
  const observationResult = attachObservationStableRefs(
    input.observations,
    new Set(input.touchedObservationIds),
    input.recordedAt
  );
  const claimResult = attachClaimStableRefs(
    input.claims,
    observationResult.nextRecords,
    new Set(input.touchedClaimIds),
    new Set(input.touchedObservationIds),
    input.recordedAt
  );
  const eventResult = attachEventStableRefs(
    input.events,
    new Set(input.touchedEventIds),
    input.recordedAt
  );
  return {
    nextObservations: observationResult.nextRecords,
    nextClaims: claimResult.nextRecords,
    nextEvents: eventResult.nextRecords,
    changed:
      observationResult.changed ||
      claimResult.changed ||
      eventResult.changed
  };
}
/** Resolves the canonical stable ref id for an observation record. */
export function resolveProfileMemoryGraphObservationStableRefId(
  observation: ProfileMemoryGraphObservationRecord
): string | null {
  if (observation.payload.redactionState === "redacted") {
    return null;
  }
  return (
    normalizeStableRefId(observation.payload.stableRefId) ??
    deriveStableRefIdFromNormalizedKey(observation.payload.normalizedKey)
  );
}
/** Resolves the canonical stable ref id for a claim record. */
export function resolveProfileMemoryGraphClaimStableRefId(
  claim: ProfileMemoryGraphClaimRecord
): string | null {
  if (claim.payload.redactionState === "redacted") {
    return null;
  }
  return (
    normalizeStableRefId(claim.payload.stableRefId) ??
    deriveStableRefIdFromNormalizedKey(claim.payload.normalizedKey)
  );
}
/** Resolves a single event stable ref id when the event maps to one identity. */
export function resolveProfileMemoryGraphEventStableRefId(
  event: ProfileMemoryGraphEventRecord
): string | null {
  const stableRefIds = resolveProfileMemoryGraphEventStableRefIds(event);
  return stableRefIds.length === 1 ? stableRefIds[0] : null;
}
/** Resolves the full stable-ref set for an event record. */
export function resolveProfileMemoryGraphEventStableRefIds(
  event: ProfileMemoryGraphEventRecord
): readonly string[] {
  if (event.payload.redactionState === "redacted") {
    return [];
  }
  const explicitStableRefId = normalizeStableRefId(event.payload.stableRefId);
  if (explicitStableRefId !== null) {
    return [explicitStableRefId];
  }
  const derivedStableRefIds = [...new Set(
    event.payload.entityRefIds
      .map((entityRefId) => deriveStableRefIdFromEntityRef(entityRefId))
      .filter((stableRefId): stableRefId is string => stableRefId !== null)
  )].sort((left, right) => left.localeCompare(right));
  if (derivedStableRefIds.length > 0) {
    return derivedStableRefIds;
  }
  return event.payload.entityRefIds.length === 0
    ? [PROFILE_MEMORY_SELF_STABLE_REF_ID]
    : [];
}
/** Groups graph records by their resolved stable ref ids. */
export function queryProfileMemoryGraphStableRefGroups(
  graph: ProfileMemoryGraphState
): readonly ProfileMemoryGraphStableRefGroup[] {
  const groups = new Map<string, MutableStableRefGroup>();

  for (const observation of graph.observations) {
    const stableRefId = resolveProfileMemoryGraphObservationStableRefId(observation);
    if (stableRefId === null) {
      continue;
    }
    const group = getOrCreateStableRefGroup(groups, stableRefId);
    group.observationIds.add(observation.payload.observationId);
    addMaybeString(group.families, observation.payload.family);
    for (const entityRefId of observation.payload.entityRefIds) {
      addMaybeString(group.entityRefIds, entityRefId);
    }
  }

  for (const claim of graph.claims) {
    const stableRefId = resolveProfileMemoryGraphClaimStableRefId(claim);
    if (stableRefId === null) {
      continue;
    }
    const group = getOrCreateStableRefGroup(groups, stableRefId);
    group.claimIds.add(claim.payload.claimId);
    addMaybeString(group.families, claim.payload.family);
    for (const entityRefId of claim.payload.entityRefIds) {
      addMaybeString(group.entityRefIds, entityRefId);
    }
  }

  for (const event of graph.events) {
    for (const stableRefId of resolveProfileMemoryGraphEventStableRefIds(event)) {
      const group = getOrCreateStableRefGroup(groups, stableRefId);
      group.eventIds.add(event.payload.eventId);
      addMaybeString(group.families, event.payload.family);
      for (const entityRefId of event.payload.entityRefIds) {
        addMaybeString(group.entityRefIds, entityRefId);
      }
    }
  }

  return [...groups.values()]
    .map((group) => ({
      stableRefId: group.stableRefId,
      resolution: classifyProfileMemoryGraphStableRefResolution(group.stableRefId),
      observationIds: sortSet(group.observationIds),
      claimIds: sortSet(group.claimIds),
      eventIds: sortSet(group.eventIds),
      entityRefIds: sortSet(group.entityRefIds),
      families: sortSet(group.families)
    }))
    .sort((left, right) => left.stableRefId.localeCompare(right.stableRefId));
}
/** Returns active current-surface claims anchored to resolved stable refs. */
export function queryProfileMemoryGraphResolvedCurrentClaims(
  graph: ProfileMemoryGraphState
): readonly ProfileMemoryGraphClaimRecord[] {
  return graph.claims.filter((claim) => {
    if (!claim.payload.active || claim.payload.redactionState === "redacted") {
      return false;
    }
    if (!isProfileMemoryGraphClaimCurrentSurfaceEligible(claim)) {
      return false;
    }
    const stableRefId = resolveProfileMemoryGraphClaimStableRefId(claim);
    return (
      stableRefId !== null &&
      classifyProfileMemoryGraphStableRefResolution(stableRefId) === "resolved_current"
    );
  });
}
/** Rewrites touched observations with their canonical stable refs. */
function attachObservationStableRefs(
  observations: readonly ProfileMemoryGraphObservationRecord[],
  touchedObservationIds: ReadonlySet<string>,
  recordedAt: string
): {
  nextRecords: ProfileMemoryGraphObservationRecord[];
  changed: boolean;
} {
  let changed = false;
  const nextRecords = observations.map((observation) => {
    if (!touchedObservationIds.has(observation.payload.observationId)) {
      return observation;
    }
    const stableRefId = resolveProfileMemoryGraphObservationStableRefId(observation);
    if (observation.payload.stableRefId === stableRefId) {
      return observation;
    }
    changed = true;
    return rebuildProfileMemoryGraphEnvelope({
      record: observation,
      schemaName: PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
      payload: {
        ...observation.payload,
        stableRefId
      },
      fallbackCreatedAt: recordedAt
    });
  });
  return { nextRecords, changed };
}
/** Rewrites touched or observation-linked claims with canonical stable refs. */
function attachClaimStableRefs(
  claims: readonly ProfileMemoryGraphClaimRecord[],
  observations: readonly ProfileMemoryGraphObservationRecord[],
  touchedClaimIds: ReadonlySet<string>,
  touchedObservationIds: ReadonlySet<string>,
  recordedAt: string
): {
  nextRecords: ProfileMemoryGraphClaimRecord[];
  changed: boolean;
} {
  let changed = false;
  const observationsById = new Map(
    observations.map((observation) => [observation.payload.observationId, observation])
  );
  const nextRecords = claims.map((claim) => {
    const hasAttachedSupportingObservation = claim.payload.derivedFromObservationIds.some(
      (observationId) =>
        normalizeStableRefId(observationsById.get(observationId)?.payload.stableRefId ?? null) !==
        null
    );
    if (
      !touchedClaimIds.has(claim.payload.claimId) &&
      !hasAttachedSupportingObservation &&
      !claim.payload.derivedFromObservationIds.some((observationId) =>
        touchedObservationIds.has(observationId)
      )
    ) {
      return claim;
    }
    const stableRefId = resolveProfileMemoryGraphClaimStableRefId(claim);
    if (claim.payload.stableRefId === stableRefId) {
      return claim;
    }
    changed = true;
    return rebuildProfileMemoryGraphEnvelope({
      record: claim,
      schemaName: PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
      payload: {
        ...claim.payload,
        stableRefId
      },
      fallbackCreatedAt: recordedAt
    });
  });
  return { nextRecords, changed };
}
/** Rewrites touched events with their canonical stable ref assignments. */
function attachEventStableRefs(
  events: readonly ProfileMemoryGraphEventRecord[],
  touchedEventIds: ReadonlySet<string>,
  recordedAt: string
): {
  nextRecords: ProfileMemoryGraphEventRecord[];
  changed: boolean;
} {
  let changed = false;
  const nextRecords = events.map((event) => {
    if (!touchedEventIds.has(event.payload.eventId)) {
      return event;
    }
    const stableRefId = resolveProfileMemoryGraphEventStableRefId(event);
    if (event.payload.stableRefId === stableRefId) {
      return event;
    }
    changed = true;
    return rebuildProfileMemoryGraphEnvelope({
      record: event,
      schemaName: PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME,
      payload: {
        ...event.payload,
        stableRefId
      },
      fallbackCreatedAt: recordedAt
    });
  });
  return { nextRecords, changed };
}
/** Returns the mutable aggregation bucket for a stable ref id. */
function getOrCreateStableRefGroup(
  groups: Map<string, MutableStableRefGroup>,
  stableRefId: string
): MutableStableRefGroup {
  const existing = groups.get(stableRefId);
  if (existing) {
    return existing;
  }
  const created: MutableStableRefGroup = {
    stableRefId,
    observationIds: new Set<string>(),
    claimIds: new Set<string>(),
    eventIds: new Set<string>(),
    entityRefIds: new Set<string>(),
    families: new Set<string>()
  };
  groups.set(stableRefId, created);
  return created;
}

/** Classifies whether a stable ref is resolved current or provisional. */
function classifyProfileMemoryGraphStableRefResolution(
  stableRefId: string
): ProfileMemoryGraphStableRefResolution {
  return stableRefId === PROFILE_MEMORY_SELF_STABLE_REF_ID
    ? "resolved_current"
    : stableRefId.startsWith(PROFILE_MEMORY_QUARANTINE_STABLE_REF_PREFIX) ? "quarantined"
    : "provisional";
}

/** Derives a stable ref id from a canonical normalized key when possible. */
function deriveStableRefIdFromNormalizedKey(normalizedKey: string | null): string | null {
  const normalized = normalizeGraphKey(normalizedKey);
  if (normalized === null) {
    return null;
  }
  const contactToken = extractContactTokenFromGraphKey(normalized);
  if (contactToken !== null) {
    return buildProfileMemoryContactStableRefId(contactToken);
  }
  return PROFILE_MEMORY_SELF_STABLE_REF_ID;
}

/** Derives a stable ref id from a normalized entity ref string. */
function deriveStableRefIdFromEntityRef(entityRefId: string): string | null {
  const normalizedEntityRefId = normalizeGraphKey(entityRefId);
  if (normalizedEntityRefId === null) {
    return null;
  }
  if (
    normalizedEntityRefId === "self" ||
    normalizedEntityRefId === "profile.self" ||
    normalizedEntityRefId === "identity.self"
  ) {
    return PROFILE_MEMORY_SELF_STABLE_REF_ID;
  }
  const contactToken = extractContactTokenFromGraphKey(normalizedEntityRefId);
  return contactToken === null
    ? null
    : buildProfileMemoryContactStableRefId(contactToken);
}

/** Extracts a contact token from a canonical graph key. */
function extractContactTokenFromGraphKey(normalizedKey: string): string | null {
  if (!normalizedKey.startsWith("contact.")) {
    return null;
  }
  const [, rawContactToken] = normalizedKey.split(".", 3);
  return normalizeContactToken(rawContactToken ?? null);
}

/** Canonicalizes a contact token for stable-ref issuance. */
function normalizeContactToken(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/** Canonicalizes graph keys before stable-ref derivation. */
function normalizeGraphKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/** Canonicalizes a persisted stable ref id or returns null. */
function normalizeStableRefId(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Adds a trimmed non-empty string to a grouping bucket. */
function addMaybeString(bucket: Set<string>, value: string | null | undefined): void {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return;
  }
  bucket.add(trimmed);
}

/** Returns a stable lexical ordering for a string set. */
function sortSet(values: ReadonlySet<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}
