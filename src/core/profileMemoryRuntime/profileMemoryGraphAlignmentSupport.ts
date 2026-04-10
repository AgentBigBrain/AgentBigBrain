/**
 * @fileoverview Bounded Stage 6.86 alignment helpers for profile-memory stable-ref groups.
 */

import type { EntityGraphV1 } from "../types";
import { queryEntityGraphNodesByCanonicalOrAlias } from "../stage6_86EntityGraph";
import type {
  ProfileMemoryGraphClaimRecord,
  ProfileMemoryGraphEventRecord,
  ProfileMemoryGraphObservationRecord,
  ProfileMemoryGraphStableRefResolution,
  ProfileMemoryGraphState
} from "./profileMemoryGraphContracts";
import {
  queryProfileMemoryGraphStableRefGroups,
  resolveProfileMemoryGraphClaimStableRefId,
  resolveProfileMemoryGraphEventStableRefIds,
  resolveProfileMemoryGraphObservationStableRefId,
  type ProfileMemoryGraphStableRefGroup
} from "./profileMemoryGraphQueries";

export interface ProfileMemoryGraphAlignedStableRefGroup
  extends ProfileMemoryGraphStableRefGroup {
  primaryEntityKey: string | null;
  observedEntityKey: string | null;
}

/** Attaches bounded Stage 6.86 entity keys onto existing stable-ref groups. */
export function queryProfileMemoryGraphAlignedStableRefGroups(input: {
  graph: ProfileMemoryGraphState;
  entityGraph: EntityGraphV1;
}): readonly ProfileMemoryGraphAlignedStableRefGroup[] {
  return queryProfileMemoryGraphStableRefGroups(input.graph).map((group) => {
    const matchedEntityKeys = collectMatchedEntityKeys(input.graph, input.entityGraph, group);
    const observedEntityKey = matchedEntityKeys.length === 1 ? matchedEntityKeys[0] : null;
    const resolution = selectAlignedStableRefResolution(group.resolution, matchedEntityKeys);
    return {
      ...group,
      resolution,
      primaryEntityKey:
        resolution === "quarantined" ? null : observedEntityKey,
      observedEntityKey
    };
  });
}

/** Collects the exact Stage 6.86 entity keys that match one stable-ref group. */
function collectMatchedEntityKeys(
  graph: ProfileMemoryGraphState,
  entityGraph: EntityGraphV1,
  group: ProfileMemoryGraphStableRefGroup
): readonly string[] {
  const matched = new Set<string>();
  for (const label of collectStableRefAlignmentLabels(graph, group.stableRefId)) {
    for (const entity of queryEntityGraphNodesByCanonicalOrAlias(entityGraph, label)) {
      matched.add(entity.entityKey);
    }
  }
  return [...matched].sort((left, right) => left.localeCompare(right));
}

/** Builds one bounded label set that can be reconciled against Stage 6.86 identity lookup. */
function collectStableRefAlignmentLabels(
  graph: ProfileMemoryGraphState,
  stableRefId: string
): readonly string[] {
  const labels = new Set<string>();
  addAlignmentLabel(labels, deriveLabelFromStableRefId(stableRefId));
  addObservationAlignmentLabels(labels, graph.observations, stableRefId);
  addClaimAlignmentLabels(labels, graph.claims, stableRefId);
  addEventAlignmentLabels(labels, graph.events, stableRefId);
  return [...labels].sort((left, right) => left.localeCompare(right));
}

/** Adds observation-derived contact labels for one stable-ref lane. */
function addObservationAlignmentLabels(
  bucket: Set<string>,
  observations: readonly ProfileMemoryGraphObservationRecord[],
  stableRefId: string
): void {
  for (const observation of observations) {
    if (resolveProfileMemoryGraphObservationStableRefId(observation) !== stableRefId) {
      continue;
    }
    addAlignmentLabel(bucket, deriveLabelFromGraphKey(observation.payload.normalizedKey));
    for (const entityRefId of observation.payload.entityRefIds) {
      addAlignmentLabel(bucket, deriveLabelFromGraphKey(entityRefId));
    }
  }
}

/** Adds claim-derived contact labels for one stable-ref lane. */
function addClaimAlignmentLabels(
  bucket: Set<string>,
  claims: readonly ProfileMemoryGraphClaimRecord[],
  stableRefId: string
): void {
  for (const claim of claims) {
    if (resolveProfileMemoryGraphClaimStableRefId(claim) !== stableRefId) {
      continue;
    }
    addAlignmentLabel(bucket, deriveLabelFromGraphKey(claim.payload.normalizedKey));
    for (const entityRefId of claim.payload.entityRefIds) {
      addAlignmentLabel(bucket, deriveLabelFromGraphKey(entityRefId));
    }
  }
}

/** Adds event-derived contact labels for one stable-ref lane. */
function addEventAlignmentLabels(
  bucket: Set<string>,
  events: readonly ProfileMemoryGraphEventRecord[],
  stableRefId: string
): void {
  for (const event of events) {
    if (!resolveProfileMemoryGraphEventStableRefIds(event).includes(stableRefId)) {
      continue;
    }
    for (const entityRefId of event.payload.entityRefIds) {
      addAlignmentLabel(bucket, deriveLabelFromGraphKey(entityRefId));
    }
  }
}

/** Extracts one contact-style alignment label directly from a stable ref id. */
function deriveLabelFromStableRefId(stableRefId: string): string | null {
  return deriveContactLabel(
    stableRefId.startsWith("stable_quarantine_contact_")
      ? stableRefId.slice("stable_quarantine_contact_".length)
      : stableRefId.startsWith("stable_contact_")
        ? stableRefId.slice("stable_contact_".length)
        : null
  );
}

/** Extracts one contact-style alignment label from a graph key or entity ref. */
function deriveLabelFromGraphKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  if (!trimmed.startsWith("contact.")) {
    return null;
  }
  const segments = trimmed.split(".");
  return deriveContactLabel(segments[1] ?? null);
}

/** Normalizes one raw contact token into the bounded label form used for exact matching. */
function deriveContactLabel(rawToken: string | null): string | null {
  if (typeof rawToken !== "string") {
    return null;
  }
  const trimmed = rawToken.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/_/g, " ");
}

/** Adds one non-empty alignment label to the bounded candidate bucket. */
function addAlignmentLabel(bucket: Set<string>, value: string | null): void {
  if (!value) {
    return;
  }
  bucket.add(value);
}

/** Preserves base resolution unless multiple Stage 6.86 identities keep the lane ambiguous. */
function selectAlignedStableRefResolution(
  baseResolution: ProfileMemoryGraphStableRefResolution,
  matchedEntityKeys: readonly string[]
): ProfileMemoryGraphStableRefResolution {
  return baseResolution === "quarantined" || matchedEntityKeys.length > 1
    ? "quarantined"
    : baseResolution;
}
