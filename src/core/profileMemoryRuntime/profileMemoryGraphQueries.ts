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

/**
 * Gets profile memory self stable ref id.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @returns Result produced by this helper.
 */
export function getProfileMemorySelfStableRefId(): string {
  return PROFILE_MEMORY_SELF_STABLE_REF_ID;
}
/**
 * Builds profile memory contact stable ref id.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param contactToken - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function buildProfileMemoryContactStableRefId(
  contactToken: string
): string | null {
  const normalizedContactToken = normalizeContactToken(contactToken);
  return normalizedContactToken === null
    ? null
    : `${PROFILE_MEMORY_CONTACT_STABLE_REF_PREFIX}${normalizedContactToken}`;
}
/**
 * Attaches profile memory graph stable refs.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ProfileMemoryGraphClaimRecord` (import `ProfileMemoryGraphClaimRecord`) from `./profileMemoryGraphContracts`.
 * - Uses `ProfileMemoryGraphEventRecord` (import `ProfileMemoryGraphEventRecord`) from `./profileMemoryGraphContracts`.
 * - Uses `ProfileMemoryGraphObservationRecord` (import `ProfileMemoryGraphObservationRecord`) from `./profileMemoryGraphContracts`.
 * @param input - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
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
/**
 * Resolves profile memory graph observation stable ref id.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ProfileMemoryGraphObservationRecord` (import `ProfileMemoryGraphObservationRecord`) from `./profileMemoryGraphContracts`.
 * @param observation - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
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
/**
 * Resolves profile memory graph claim stable ref id.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ProfileMemoryGraphClaimRecord` (import `ProfileMemoryGraphClaimRecord`) from `./profileMemoryGraphContracts`.
 * @param claim - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
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
/**
 * Resolves profile memory graph event stable ref id.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ProfileMemoryGraphEventRecord` (import `ProfileMemoryGraphEventRecord`) from `./profileMemoryGraphContracts`.
 * @param event - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function resolveProfileMemoryGraphEventStableRefId(
  event: ProfileMemoryGraphEventRecord
): string | null {
  const stableRefIds = resolveProfileMemoryGraphEventStableRefIds(event);
  return stableRefIds.length === 1 ? stableRefIds[0] : null;
}
/**
 * Resolves profile memory graph event stable ref ids.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ProfileMemoryGraphEventRecord` (import `ProfileMemoryGraphEventRecord`) from `./profileMemoryGraphContracts`.
 * @param event - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
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
/**
 * Queries profile memory graph stable ref groups.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ProfileMemoryGraphState` (import `ProfileMemoryGraphState`) from `./profileMemoryGraphContracts`.
 * @param graph - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
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
/**
 * Queries profile memory graph current surface claims.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `isProfileMemoryGraphClaimCurrentSurfaceEligible` (import `isProfileMemoryGraphClaimCurrentSurfaceEligible`) from `./profileMemoryGraphClaimSurfaceEligibilitySupport`.
 * - Uses `ProfileMemoryGraphClaimRecord` (import `ProfileMemoryGraphClaimRecord`) from `./profileMemoryGraphContracts`.
 * - Uses `ProfileMemoryGraphState` (import `ProfileMemoryGraphState`) from `./profileMemoryGraphContracts`.
 * @param graph - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function queryProfileMemoryGraphCurrentSurfaceClaims(
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
      classifyProfileMemoryGraphStableRefResolution(stableRefId) !== "quarantined"
    );
  });
}
/**
 * Queries profile memory graph resolved current claims.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ProfileMemoryGraphClaimRecord` (import `ProfileMemoryGraphClaimRecord`) from `./profileMemoryGraphContracts`.
 * - Uses `ProfileMemoryGraphState` (import `ProfileMemoryGraphState`) from `./profileMemoryGraphContracts`.
 * @param graph - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function queryProfileMemoryGraphResolvedCurrentClaims(
  graph: ProfileMemoryGraphState
): readonly ProfileMemoryGraphClaimRecord[] {
  return queryProfileMemoryGraphCurrentSurfaceClaims(graph).filter((claim) => {
    const stableRefId = resolveProfileMemoryGraphClaimStableRefId(claim);
    return (
      stableRefId !== null &&
      classifyProfileMemoryGraphStableRefResolution(stableRefId) === "resolved_current"
    );
  });
}
/**
 * Attaches observation stable refs.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME` (import `PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME`) from `./profileMemoryGraphContracts`.
 * - Uses `ProfileMemoryGraphObservationRecord` (import `ProfileMemoryGraphObservationRecord`) from `./profileMemoryGraphContracts`.
 * - Uses `rebuildProfileMemoryGraphEnvelope` (import `rebuildProfileMemoryGraphEnvelope`) from `./profileMemoryGraphStateSupport`.
 * @param observations - Input consumed by this helper.
 * @param touchedObservationIds - Input consumed by this helper.
 * @param recordedAt - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
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
/**
 * Attaches claim stable refs.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME` (import `PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME`) from `./profileMemoryGraphContracts`.
 * - Uses `ProfileMemoryGraphClaimRecord` (import `ProfileMemoryGraphClaimRecord`) from `./profileMemoryGraphContracts`.
 * - Uses `ProfileMemoryGraphObservationRecord` (import `ProfileMemoryGraphObservationRecord`) from `./profileMemoryGraphContracts`.
 * - Uses `rebuildProfileMemoryGraphEnvelope` (import `rebuildProfileMemoryGraphEnvelope`) from `./profileMemoryGraphStateSupport`.
 * @param claims - Input consumed by this helper.
 * @param observations - Input consumed by this helper.
 * @param touchedClaimIds - Input consumed by this helper.
 * @param touchedObservationIds - Input consumed by this helper.
 * @param recordedAt - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
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
/**
 * Attaches event stable refs.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME` (import `PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME`) from `./profileMemoryGraphContracts`.
 * - Uses `ProfileMemoryGraphEventRecord` (import `ProfileMemoryGraphEventRecord`) from `./profileMemoryGraphContracts`.
 * - Uses `rebuildProfileMemoryGraphEnvelope` (import `rebuildProfileMemoryGraphEnvelope`) from `./profileMemoryGraphStateSupport`.
 * @param events - Input consumed by this helper.
 * @param touchedEventIds - Input consumed by this helper.
 * @param recordedAt - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
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
/**
 * Gets or create stable ref group.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param groups - Input consumed by this helper.
 * @param stableRefId - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
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
/**
 * Classifies profile memory graph stable ref resolution.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ProfileMemoryGraphStableRefResolution` (import `ProfileMemoryGraphStableRefResolution`) from `./profileMemoryGraphContracts`.
 * @param stableRefId - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function classifyProfileMemoryGraphStableRefResolution(
  stableRefId: string
): ProfileMemoryGraphStableRefResolution {
  return stableRefId === PROFILE_MEMORY_SELF_STABLE_REF_ID
    ? "resolved_current"
    : stableRefId.startsWith(PROFILE_MEMORY_QUARANTINE_STABLE_REF_PREFIX) ? "quarantined"
    : "provisional";
}
/**
 * Derives stable ref id from normalized key.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param normalizedKey - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
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
/**
 * Derives stable ref id from entity ref.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param entityRefId - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
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
/**
 * Extracts contact token from graph key.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param normalizedKey - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function extractContactTokenFromGraphKey(normalizedKey: string): string | null {
  if (!normalizedKey.startsWith("contact.")) {
    return null;
  }
  const [, rawContactToken] = normalizedKey.split(".", 3);
  return normalizeContactToken(rawContactToken ?? null);
}
/**
 * Normalizes contact token.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function normalizeContactToken(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}
/**
 * Normalizes graph key.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function normalizeGraphKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}
/**
 * Normalizes stable ref id.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function normalizeStableRefId(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
/**
 * Adds maybe string.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param bucket - Input consumed by this helper.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
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
/**
 * Sorts set.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param values - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function sortSet(values: ReadonlySet<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}
