/**
 * @fileoverview Compatibility-slice helpers for the legacy temporal memory synthesis adapter.
 */

import { inferGovernanceFamilyForNormalizedKey } from "../../core/profileMemoryRuntime/profileMemoryGovernanceFamilyInference";
import type {
  ProfileMemoryTemporalClaimFamilySlice,
  ProfileMemoryTemporalEvidenceSlice,
  ProfileMemoryTemporalEventEvidence,
  ProfileMemoryTemporalLaneMetadata,
  ProfileMemoryTemporalRelevanceScope,
  ProfileMemoryTemporalSemanticMode
} from "../../core/profileMemoryRuntime/profileMemoryTemporalQueryContracts";
import type { MemorySynthesisEpisodeRecord, MemorySynthesisFactRecord } from "./contracts";
import type { MemoryBoundaryLaneOutput } from "../memoryContext/contracts";

/**
 * Derives one deterministic stable ref id from a legacy compatibility key.
 *
 * **Why it exists:**
 * The legacy adapter must collapse old flat fact keys onto the same stable-ref grouping rule
 * before handing them to the canonical temporal core.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Legacy compatibility key.
 * @returns Stable ref id used by the adapter slice.
 */
export function deriveStableRefId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "self" || normalized === "profile.self" || normalized === "identity.self") {
    return "stable_self_profile_owner";
  }
  const contactMatch = normalized.match(/contact\.([^.]+)/);
  return contactMatch ? `stable_contact_${contactMatch[1]}` : "stable_self_profile_owner";
}

/**
 * Builds lifecycle buckets for legacy facts before they enter the canonical temporal slice.
 *
 * **Why it exists:**
 * Compatibility facts already carry limited decision metadata, so the adapter needs one central
 * rule to map that state onto temporal lifecycle buckets.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param facts - Legacy fact candidates for one family.
 * @returns Temporal lifecycle buckets for the family slice.
 */
export function buildFactLifecycleBuckets(
  facts: readonly MemorySynthesisFactRecord[]
): ProfileMemoryTemporalClaimFamilySlice["lifecycleBuckets"] {
  const current: string[] = [];
  const historical: string[] = [];
  for (const fact of facts) {
    if (fact.decisionRecord?.disposition === "selected_supporting_history" || fact.status === "superseded") {
      historical.push(fact.factId);
      continue;
    }
    current.push(fact.factId);
  }
  return {
    current,
    historical,
    ended: [],
    overflowNote: null
  };
}

/**
 * Builds the canonical temporal evidence slice from legacy episodes and facts.
 *
 * **Why it exists:**
 * The adapter is intentionally one-way, so all legacy compatibility synthesis must first pass
 * through the canonical temporal input shape.
 *
 * **What it talks to:**
 * - Uses `inferGovernanceFamilyForNormalizedKey` (import `inferGovernanceFamilyForNormalizedKey`) from `../../core/profileMemoryRuntime/profileMemoryGovernanceFamilyInference`.
 * - Uses local helpers within this module.
 *
 * @param episodes - Legacy episode candidates.
 * @param facts - Legacy fact candidates.
 * @returns Canonical temporal evidence slice for adapter-only synthesis.
 */
export function buildCompatibilitySlice(
  episodes: readonly MemorySynthesisEpisodeRecord[],
  facts: readonly MemorySynthesisFactRecord[]
): ProfileMemoryTemporalEvidenceSlice {
  const groupedFacts = new Map<string, Map<string, MemorySynthesisFactRecord[]>>();
  for (const fact of facts) {
    const stableRefId = deriveStableRefId(fact.key);
    const family = fact.decisionRecord?.family ?? inferGovernanceFamilyForNormalizedKey(fact.key, fact.value);
    const factsByFamily = groupedFacts.get(stableRefId) ?? new Map<string, MemorySynthesisFactRecord[]>();
    const familyFacts = factsByFamily.get(family) ?? [];
    familyFacts.push(fact);
    factsByFamily.set(family, familyFacts);
    groupedFacts.set(stableRefId, factsByFamily);
  }

  const eventsByStableRefId = new Map<string, ProfileMemoryTemporalEventEvidence[]>();
  for (const episode of episodes) {
    const stableRefId = deriveStableRefId(episode.entityRefs[0] ?? "self");
    const current = eventsByStableRefId.get(stableRefId) ?? [];
    current.push({
      eventId: episode.episodeId,
      stableRefId,
      family: "episode.candidate",
      title: episode.title,
      summary: episode.summary,
      assertedAt: episode.lastMentionedAt,
      observedAt: episode.lastMentionedAt,
      validFrom: episode.lastMentionedAt,
      validTo: episode.status === "resolved" ? episode.lastMentionedAt : null,
      sourceTier: "explicit_user_statement",
      entityRefIds: [...episode.entityRefs],
      supportingObservationIds: []
    });
    eventsByStableRefId.set(stableRefId, current);
  }

  const focusStableRefIds = [...new Set([...groupedFacts.keys(), ...eventsByStableRefId.keys()])];
  return {
    semanticMode: "relationship_inventory",
    relevanceScope: "global_profile",
    asOfValidTime: null,
    asOfObservedTime: null,
    caps: {
      maxFocusEntities: 3,
      maxClaimFamiliesPerFocusEntity: 5,
      maxCandidateClaimsPerFamily: 6,
      maxEventsPerFocusEntity: 3,
      maxObservationsPerCluster: 4,
      maxContradictionNotes: 2
    },
    focusEntities: focusStableRefIds.map((stableRefId) => ({
      stableRefId,
      resolution: stableRefId.startsWith("stable_quarantine_")
        ? "quarantined"
        : stableRefId === "stable_self_profile_owner"
          ? "resolved_current"
          : "provisional",
      matchedHintTerms: [],
      claimFamilies: [...(groupedFacts.get(stableRefId)?.entries() ?? [])].map(([family, familyFacts]) => ({
        family: family as ProfileMemoryTemporalClaimFamilySlice["family"],
        claims: familyFacts.map((fact) => ({
          claimId: fact.factId,
          stableRefId,
          family: family as ProfileMemoryTemporalClaimFamilySlice["family"],
          normalizedKey: fact.key,
          normalizedValue: fact.value,
          assertedAt: fact.lastUpdatedAt,
          validFrom: fact.observedAt,
          validTo: null,
          endedAt: null,
          active: fact.status !== "superseded",
          sourceTier: "explicit_user_statement",
          entityRefIds: [],
          supportingObservationIds: []
        })),
        lifecycleBuckets: buildFactLifecycleBuckets(familyFacts)
      })),
      eventSlice: {
        events: eventsByStableRefId.get(stableRefId) ?? [],
        lifecycleBuckets: {
          current: (eventsByStableRefId.get(stableRefId) ?? [])
            .filter((event) => event.validTo === null)
            .map((event) => event.eventId),
          historical: (eventsByStableRefId.get(stableRefId) ?? [])
            .filter((event) => event.validTo !== null)
            .map((event) => event.eventId),
          ended: [],
          overflowNote: null
        }
      },
      observationsById: {},
      degradedNotes: []
    })),
    degradedNotes: []
  };
}

/**
 * Projects one temporal lane onto the legacy memory-boundary surface.
 *
 * **Why it exists:**
 * The legacy adapter still emits lane metadata, but that output must stay derived from the
 * canonical temporal lane contract.
 *
 * **What it talks to:**
 * - Uses `ProfileMemoryTemporalLaneMetadata` (import `ProfileMemoryTemporalLaneMetadata`) from `../../core/profileMemoryRuntime/profileMemoryTemporalQueryContracts`.
 *
 * @param lane - Canonical temporal lane metadata.
 * @returns Legacy boundary-lane output.
 */
export function toLaneBoundary(
  lane: ProfileMemoryTemporalLaneMetadata,
  context: {
    semanticMode: ProfileMemoryTemporalSemanticMode;
    relevanceScope: ProfileMemoryTemporalRelevanceScope;
    scopedThreadKeys: readonly string[];
  }
): MemoryBoundaryLaneOutput {
  return {
    laneId: lane.laneId,
    domainLane: classifyMemoryBoundaryLaneDomain(lane),
    semanticMode: context.semanticMode,
    relevanceScope: context.relevanceScope,
    scopedThreadKeys: [...context.scopedThreadKeys],
    answerMode: lane.answerMode,
    dominantLane: lane.dominantLane,
    supportingLanes: lane.supportingLanes,
    overflowNote: lane.lifecycleBuckets.overflowNote,
    degradedNotes: lane.degradedNotes
  };
}

/**
 * Projects one canonical temporal lane onto the shared broker-domain lane contract.
 *
 * **Why it exists:**
 * Phase 6.5 replaces rendered-memory text parsing with typed lane metadata, so temporal lane
 * metadata needs one deterministic domain projection before boundary scoring consumes it.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param lane - Canonical temporal lane metadata.
 * @returns Shared domain lane used by broker boundary scoring.
 */
function classifyMemoryBoundaryLaneDomain(
  lane: ProfileMemoryTemporalLaneMetadata
): MemoryBoundaryLaneOutput["domainLane"] {
  if (lane.family === "followup.resolution") {
    return "workflow";
  }
  if (
    lane.family === "identity.preferred_name" ||
    lane.family === "employment.current" ||
    lane.family === "residence.current" ||
    lane.family === "generic.profile_fact"
  ) {
    return "profile";
  }
  if (lane.family?.startsWith("contact.")) {
    return "relationship";
  }
  if (lane.focusStableRefId === "stable_self_profile_owner") {
    return "profile";
  }
  return lane.family === null ? "relationship" : "unknown";
}
