/**
 * @fileoverview Shared helpers for graph-aware profile fact continuity queries and compatibility
 * temporal fallback synthesis.
 */

import {
  getEntityLookupTerms,
  queryEntityGraphNodesByCanonicalOrAlias
} from "../stage6_86EntityGraph";
import type { ConversationStackV1, EntityGraphV1 } from "../types";
import { inferGovernanceFamilyForNormalizedKey } from "./profileMemoryGovernanceFamilyInference";
import {
  buildProfileMemoryContactStableRefId,
  getProfileMemorySelfStableRefId
} from "./profileMemoryGraphQueries";
import type { ProfileMemoryGraphStableRefResolution } from "./profileMemoryGraphContracts";
import { selectProfileMemoryContinuityScopedThreads } from "./profileMemoryContinuityScopeSupport";
import type { ProfileReadableFact } from "./contracts";
import {
  DEFAULT_PROFILE_MEMORY_TEMPORAL_QUERY_CAPS,
  type ProfileMemoryTemporalEvidenceSlice,
  type ProfileMemoryTemporalFocusEntitySlice,
  type ProfileMemoryTemporalRelevanceScope,
  type ProfileMemoryTemporalSemanticMode,
  type TemporalMemorySynthesis
} from "./profileMemoryTemporalQueryContracts";
import type { ProfileFactContinuityResult } from "./profileMemoryQueryContracts";

/**
 * Expands explicit continuity hints with canonical and alias terms from the shared Stage 6.86
 * entity graph.
 *
 * **Why it exists:**
 * Continuity fact selection and temporal retrieval must agree on the exact hint bundle, so the
 * graph expansion stays in one helper instead of diverging across call sites.
 *
 * **What it talks to:**
 * - Uses `queryEntityGraphNodesByCanonicalOrAlias` and `getEntityLookupTerms` (imports) from `../stage6_86EntityGraph`.
 *
 * @param graph - Current shared entity graph.
 * @param entityHints - Caller-provided continuity hints.
 * @returns Deduplicated hint terms that include exact entity-graph matches.
 */
export function expandProfileMemoryContinuityEntityHints(
  graph: EntityGraphV1,
  entityHints: readonly string[]
): readonly string[] {
  const expanded = new Set<string>();
  for (const hint of entityHints) {
    const normalizedHint = hint.trim();
    if (!normalizedHint) {
      continue;
    }
    expanded.add(normalizedHint);
    for (const entity of queryEntityGraphNodesByCanonicalOrAlias(graph, normalizedHint)) {
      expanded.add(entity.canonicalName);
      for (const term of getEntityLookupTerms(entity)) {
        expanded.add(term);
      }
    }
  }
  return [...expanded];
}

/**
 * Collects the scoped thread keys attached to one continuity query.
 *
 * **Why it exists:**
 * Continuity consumers need typed local-relevance context instead of inferring it later from raw
 * mixed-session history, so the selected thread keys are emitted explicitly here.
 *
 * **What it talks to:**
 * - Uses `selectProfileMemoryContinuityScopedThreads` (import) from `./profileMemoryContinuityScopeSupport`.
 *
 * @param stack - Current conversation stack.
 * @param relevanceScope - Requested local relevance scope.
 * @returns Ordered scoped thread keys.
 */
export function collectProfileMemoryContinuityScopedThreadKeys(
  stack: ConversationStackV1 | undefined,
  relevanceScope: ProfileMemoryTemporalRelevanceScope
): readonly string[] {
  return selectProfileMemoryContinuityScopedThreads(stack, relevanceScope).map(
    (thread) => thread.threadKey
  );
}

/**
 * Builds the public continuity result shape while preserving array-style fact consumers.
 *
 * **Why it exists:**
 * Phase 6.5 needs typed temporal metadata without breaking older array consumers, so the metadata
 * is attached to an array-shaped result in one stable helper.
 *
 * **What it talks to:**
 * - Uses local object/array projection only.
 *
 * @param facts - Selected continuity facts.
 * @param semanticMode - Requested semantic mode.
 * @param relevanceScope - Requested relevance scope.
 * @param scopedThreadKeys - Bounded scoped thread keys for the request.
 * @param temporalSynthesis - Optional canonical temporal synthesis for the same request.
 * @returns Array-shaped continuity result with typed metadata attached.
 */
export function buildProfileFactContinuityResult(
  facts: readonly ProfileReadableFact[],
  semanticMode: ProfileMemoryTemporalSemanticMode,
  relevanceScope: ProfileMemoryTemporalRelevanceScope,
  scopedThreadKeys: readonly string[],
  temporalSynthesis: TemporalMemorySynthesis | null
): ProfileFactContinuityResult {
  return Object.assign([...facts], {
    semanticMode,
    relevanceScope,
    scopedThreadKeys: [...scopedThreadKeys],
    temporalSynthesis
  }) as ProfileFactContinuityResult;
}

/**
 * Builds a compatibility temporal evidence slice when continuity fact selection succeeded but the
 * graph-backed temporal retriever returned no focus entities.
 *
 * **Why it exists:**
 * Phase 6.5 must stay graph-aware even when only compatibility facts are available, so this
 * fallback preserves typed temporal synthesis instead of collapsing back to flat fact lines.
 *
 * **What it talks to:**
 * - Uses `inferGovernanceFamilyForNormalizedKey` (import) from `./profileMemoryGovernanceFamilyInference`.
 * - Uses stable-ref helpers from `./profileMemoryGraphQueries`.
 * - Uses temporal caps/contracts from `./profileMemoryTemporalQueryContracts`.
 *
 * @param facts - Selected readable compatibility facts.
 * @param request - Temporal continuity request metadata.
 * @returns Bounded compatibility temporal slice for synthesis.
 */
export function buildProfileFactContinuityFallbackTemporalSlice(
  facts: readonly ProfileReadableFact[],
  request: {
    semanticMode: ProfileMemoryTemporalSemanticMode;
    relevanceScope: ProfileMemoryTemporalRelevanceScope;
    asOfValidTime?: string;
    asOfObservedTime?: string;
  }
): ProfileMemoryTemporalEvidenceSlice {
  if (facts.length === 0) {
    return {
      semanticMode: request.semanticMode,
      relevanceScope: request.relevanceScope,
      asOfValidTime: request.asOfValidTime ?? null,
      asOfObservedTime: request.asOfObservedTime ?? null,
      caps: DEFAULT_PROFILE_MEMORY_TEMPORAL_QUERY_CAPS,
      focusEntities: [],
      degradedNotes: []
    };
  }

  const claimsByStableRefId = new Map<string, Map<string, ProfileReadableFact[]>>();
  for (const fact of facts) {
    const stableRefId = deriveProfileFactContinuityFallbackStableRefId(fact.key);
    const family = inferGovernanceFamilyForNormalizedKey(fact.key, fact.value);
    const claimsByFamily = claimsByStableRefId.get(stableRefId) ?? new Map<string, ProfileReadableFact[]>();
    const familyFacts = claimsByFamily.get(family) ?? [];
    familyFacts.push(fact);
    claimsByFamily.set(family, familyFacts);
    claimsByStableRefId.set(stableRefId, claimsByFamily);
  }

  const focusEntities: ProfileMemoryTemporalFocusEntitySlice[] = [...claimsByStableRefId.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .slice(0, DEFAULT_PROFILE_MEMORY_TEMPORAL_QUERY_CAPS.maxFocusEntities)
    .map(([stableRefId, claimsByFamily]) => {
      const resolution: ProfileMemoryGraphStableRefResolution =
        stableRefId === getProfileMemorySelfStableRefId() ? "resolved_current" : "provisional";
      return {
        stableRefId,
        resolution,
        matchedHintTerms: [],
        claimFamilies: [...claimsByFamily.entries()]
          .sort((left, right) => left[0].localeCompare(right[0]))
          .slice(0, DEFAULT_PROFILE_MEMORY_TEMPORAL_QUERY_CAPS.maxClaimFamiliesPerFocusEntity)
          .map(([family, familyFacts]) => ({
            family: family as ReturnType<typeof inferGovernanceFamilyForNormalizedKey>,
            claims: familyFacts
              .slice(0, DEFAULT_PROFILE_MEMORY_TEMPORAL_QUERY_CAPS.maxCandidateClaimsPerFamily)
              .map((fact) => ({
                claimId: fact.factId,
                stableRefId,
                family: family as ReturnType<typeof inferGovernanceFamilyForNormalizedKey>,
                normalizedKey: fact.key,
                normalizedValue: fact.value,
                assertedAt: fact.lastUpdatedAt,
                validFrom: fact.observedAt,
                validTo: fact.status === "superseded" ? fact.lastUpdatedAt : null,
                endedAt: fact.status === "superseded" ? fact.lastUpdatedAt : null,
                active: fact.status !== "superseded",
                sourceTier: "explicit_user_statement",
                entityRefIds: [],
                supportingObservationIds: []
              })),
            lifecycleBuckets: {
              current: familyFacts
                .filter((fact) => fact.status !== "superseded")
                .map((fact) => fact.factId),
              historical: familyFacts
                .filter((fact) => fact.status === "superseded")
                .map((fact) => fact.factId),
              ended: [],
              overflowNote:
                familyFacts.length > DEFAULT_PROFILE_MEMORY_TEMPORAL_QUERY_CAPS.maxCandidateClaimsPerFamily
                  ? `bounded_overflow:${familyFacts.length - DEFAULT_PROFILE_MEMORY_TEMPORAL_QUERY_CAPS.maxCandidateClaimsPerFamily} claims omitted for ${family}`
                  : null
            }
          })),
        eventSlice: {
          events: [],
          lifecycleBuckets: {
            current: [],
            historical: [],
            ended: [],
            overflowNote: null
          }
        },
        observationsById: {},
        degradedNotes: ["continuity_fact_flat_fallback"]
      };
    });

  return {
    semanticMode: request.semanticMode,
    relevanceScope: request.relevanceScope,
    asOfValidTime: request.asOfValidTime ?? null,
    asOfObservedTime: request.asOfObservedTime ?? null,
    caps: DEFAULT_PROFILE_MEMORY_TEMPORAL_QUERY_CAPS,
    focusEntities,
    degradedNotes: ["continuity_fact_flat_fallback"]
  };
}

/**
 * Derives one continuity fallback stable ref id from a readable compatibility fact key.
 *
 * **Why it exists:**
 * Compatibility fact fallback needs deterministic focus-entity grouping even before a richer graph
 * slice is available, so this helper keeps the mapping from legacy keys to stable refs consistent.
 *
 * **What it talks to:**
 * - Uses `buildProfileMemoryContactStableRefId` and `getProfileMemorySelfStableRefId` (imports) from `./profileMemoryGraphQueries`.
 *
 * @param normalizedKey - Readable compatibility fact key.
 * @returns Deterministic stable ref id for fallback grouping.
 */
function deriveProfileFactContinuityFallbackStableRefId(normalizedKey: string): string {
  const contactMatch = normalizedKey.match(/^contact\.([^.]+)/);
  if (!contactMatch) {
    return getProfileMemorySelfStableRefId();
  }
  return buildProfileMemoryContactStableRefId(contactMatch[1]) ?? getProfileMemorySelfStableRefId();
}
