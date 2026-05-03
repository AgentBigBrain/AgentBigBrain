/**
 * @fileoverview Bounded Stage 6.86 alignment helpers for profile-memory stable-ref groups.
 */

import type { EntityGraphV1 } from "../types";
import { queryEntityGraphNodesByCanonicalOrAlias } from "../stage6_86EntityGraph";
import type {
  ProfileMemoryGraphClaimRecord,
  ProfileMemoryGraphEventRecord,
  ProfileMemoryGraphObservationRecord,
  ProfileMemoryGraphSourceTier,
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
  alignmentSourceTiers: readonly ProfileMemoryGraphSourceTier[];
  alignmentConfidence: "high" | "low";
}

const LOW_CONFIDENCE_ALIGNMENT_SOURCE_TIERS = new Set<ProfileMemoryGraphSourceTier>([
  "assistant_inference"
]);

/** Attaches bounded Stage 6.86 entity keys onto existing stable-ref groups. */
export function queryProfileMemoryGraphAlignedStableRefGroups(input: {
  graph: ProfileMemoryGraphState;
  entityGraph: EntityGraphV1;
}): readonly ProfileMemoryGraphAlignedStableRefGroup[] {
  return queryProfileMemoryGraphStableRefGroups(input.graph).map((group) => {
    const matchedEntityKeys = collectMatchedEntityKeys(input.graph, input.entityGraph, group);
    const alignmentSourceTiers = collectStableRefAlignmentSourceTiers(input.graph, group);
    const alignmentConfidence = hasLowConfidenceAlignmentSource(alignmentSourceTiers)
      ? "low"
      : "high";
    const observedEntityKey = matchedEntityKeys.length === 1 ? matchedEntityKeys[0] : null;
    const resolution = selectAlignedStableRefResolution(
      group.resolution,
      matchedEntityKeys,
      alignmentConfidence
    );
    return {
      ...group,
      resolution,
      primaryEntityKey:
        resolution === "quarantined" ? null : observedEntityKey,
      observedEntityKey,
      alignmentSourceTiers,
      alignmentConfidence
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

/** Collects source tiers backing one stable-ref alignment candidate. */
function collectStableRefAlignmentSourceTiers(
  graph: ProfileMemoryGraphState,
  group: ProfileMemoryGraphStableRefGroup
): readonly ProfileMemoryGraphSourceTier[] {
  const sourceTiers = new Set<ProfileMemoryGraphSourceTier>();
  for (const observation of graph.observations) {
    if (group.observationIds.includes(observation.payload.observationId)) {
      sourceTiers.add(observation.payload.sourceTier);
    }
  }
  for (const claim of graph.claims) {
    if (group.claimIds.includes(claim.payload.claimId)) {
      sourceTiers.add(claim.payload.sourceTier);
    }
  }
  for (const event of graph.events) {
    if (group.eventIds.includes(event.payload.eventId)) {
      sourceTiers.add(event.payload.sourceTier);
    }
  }
  return [...sourceTiers].sort((left, right) => left.localeCompare(right));
}

/** Returns whether any backing source tier is too weak to promote an exact graph alignment. */
function hasLowConfidenceAlignmentSource(
  sourceTiers: readonly ProfileMemoryGraphSourceTier[]
): boolean {
  return sourceTiers.some((sourceTier) =>
    LOW_CONFIDENCE_ALIGNMENT_SOURCE_TIERS.has(sourceTier)
  );
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
  matchedEntityKeys: readonly string[],
  alignmentConfidence: "high" | "low"
): ProfileMemoryGraphStableRefResolution {
  return baseResolution === "quarantined" ||
    matchedEntityKeys.length > 1 ||
    alignmentConfidence === "low"
    ? "quarantined"
    : baseResolution;
}
