/** @fileoverview Query helpers for planning context, graph-aware continuity facts, and readable access. */

import { createEmptyEntityGraphV1 } from "../stage6_86EntityGraph";
import type { ConversationStackV1, EntityGraphV1 } from "../types";
import { type ProfileFactRecord, type ProfileMemoryState } from "../profileMemory";
import {
  buildQueryAwarePlanningContext,
  selectProfileFactsForQuery
} from "./profileMemoryPlanningContext";
import { isCompatibilityVisibleFactLike } from "./profileMemoryCompatibilityVisibility";
import { getProfileMemoryFamilyRegistryEntry } from "./profileMemoryFamilyRegistry";
import type { ProfileMemoryQueryDecisionRecord } from "./profileMemoryDecisionRecordContracts";
import { governProfileMemoryCandidates } from "./profileMemoryTruthGovernance";
import {
  type ProfileAccessRequest,
  type ProfileFactPlanningInspectionEntry,
  type ProfileFactPlanningInspectionRequest,
  type ProfileFactPlanningInspectionResult,
  type ProfileFactReviewEntry,
  type ProfileFactReviewRequest,
  type ProfileFactReviewResult,
  type ProfileReadableFact
} from "./contracts";
import { readProfileEpisodes } from "./profileMemoryEpisodeQueries";
import { buildProfileMemoryContinuityScopeQueryInput } from "./profileMemoryContinuityScopeSupport";
import {
  buildProfileFactContinuityFallbackTemporalSlice,
  buildProfileFactContinuityResult,
  collectProfileMemoryContinuityScopedThreadKeys,
  expandProfileMemoryContinuityEntityHints
} from "./profileMemoryFactContinuitySupport";
import {
  canReadSensitiveFacts,
  deriveQueryDecisionDisposition,
  isActiveProfileFact,
  isProfileFactEffectivelySensitive,
  readAuthoritativeProfileCompatibilityFacts,
  toReadableFact,
  toStateFactRecord
} from "./profileMemoryFactQuerySupport";
import type {
  ProfileFactContinuityQueryRequest,
  ProfileFactContinuityResult,
  ProfileFactQueryInspectionRequest,
  ProfileFactQueryInspectionResult
} from "./profileMemoryQueryContracts";
import { queryProfileMemoryTemporalEvidence } from "./profileMemoryTemporalQueries";
import type {
  ProfileMemoryTemporalRelevanceScope,
  ProfileMemoryTemporalSemanticMode,
  TemporalMemorySynthesis
} from "./profileMemoryTemporalQueryContracts";
import { synthesizeProfileMemoryTemporalEvidence } from "./profileMemoryTemporalSynthesis";
export type {
  ProfileFactContinuityQueryRequest,
  ProfileFactContinuityResult,
  ProfileFactQueryInspectionRequest,
  ProfileFactQueryInspectionResult
} from "./profileMemoryQueryContracts";

/** Builds bounded fact-review entries plus hidden decision records for one approval-aware surface. */
export function reviewProfileFactsForUser(
  state: ProfileMemoryState,
  request: ProfileFactReviewRequest
): ProfileFactReviewResult {
  const inspection = inspectProfileFactsForPlanningContext(state, {
    queryInput: request.queryInput ?? "",
    maxFacts: request.maxFacts,
    asOfValidTime: request.asOfValidTime,
    asOfObservedTime: request.asOfObservedTime,
    includeSensitive: canReadSensitiveFacts({
      purpose: "operator_view",
      includeSensitive: request.includeSensitive ?? true,
      explicitHumanApproval: request.explicitHumanApproval,
      approvalId: request.approvalId
    })
  });

  return {
    entries: inspection.entries,
    hiddenDecisionRecords: inspection.hiddenDecisionRecords,
    asOfValidTime: request.asOfValidTime,
    asOfObservedTime: request.asOfObservedTime
  };
}

/** Builds bounded planning-query entries plus hidden decision records for one non-mutating surface. */
export function inspectProfileFactsForPlanningContext(
  state: ProfileMemoryState,
  request: ProfileFactPlanningInspectionRequest & {
    includeSensitive?: boolean;
  } = {}
): ProfileFactPlanningInspectionResult {
  const allowSensitive = canReadSensitiveFacts({
    purpose: "operator_view",
    includeSensitive: request.includeSensitive ?? false,
    explicitHumanApproval: request.includeSensitive === true,
    approvalId: request.includeSensitive === true ? "planning_inspection" : undefined
  });
  const inspection = inspectProfileFactQueryWithPolicy(state, {
    queryInput: request.queryInput ?? "",
    maxFacts: request.maxFacts,
    asOfValidTime: request.asOfValidTime,
    asOfObservedTime: request.asOfObservedTime
  }, allowSensitive);
  const decisionRecordsByFactId = new Map<string, ProfileMemoryQueryDecisionRecord>();
  for (const record of inspection.decisionRecords) {
    for (const evidenceRef of record.evidenceRefs) {
      if (!decisionRecordsByFactId.has(evidenceRef)) {
        decisionRecordsByFactId.set(evidenceRef, record);
      }
    }
  }

  const entries = inspection.selectedFacts.map((fact) => {
    const decisionRecord = decisionRecordsByFactId.get(fact.factId);
    if (!decisionRecord) {
      throw new Error(`Fact review entry ${fact.factId} is missing a bounded decision record.`);
    }
    return {
      fact,
      decisionRecord
    } satisfies ProfileFactPlanningInspectionEntry;
  });
  const selectedFactIds = new Set(entries.map((entry) => entry.fact.factId));

  return {
    entries,
    hiddenDecisionRecords: inspection.decisionRecords.filter((record) =>
      record.evidenceRefs.every((factId) => !selectedFactIds.has(factId))
    ),
    asOfValidTime: request.asOfValidTime,
    asOfObservedTime: request.asOfObservedTime
  } satisfies ProfileFactPlanningInspectionResult;
}

/** Builds planner-facing profile context from normalized profile-memory state. */
export function buildProfilePlanningContext(
  state: ProfileMemoryState,
  maxFacts: number,
  queryInput: string
): string {
  const inspection = inspectProfileFactQuery(state, {
    queryInput,
    maxFacts
  });
  return buildQueryAwarePlanningContext(
    {
      ...state,
      facts: inspection.selectedFacts.map((fact) => toStateFactRecord(state, fact))
    },
    maxFacts,
    queryInput
  );
}

/**
 * Returns readable active facts under approval-aware sensitivity gating.
 *
 * @param state - Loaded profile-memory state.
 * @param request - Access request with sensitivity and count controls.
 * @returns Sorted readable fact entries filtered by sensitivity policy.
 */
export function readProfileFacts(
  state: ProfileMemoryState,
  request: ProfileAccessRequest
): ProfileReadableFact[] {
  const activeFacts = [...readAuthoritativeProfileCompatibilityFacts(state)]
    .filter((fact) => isCompatibilityVisibleFactLike(fact))
    .sort((left, right) => Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt));

  const sensitiveAllowed = canReadSensitiveFacts(request);
  const maxFacts = Math.max(1, request.maxFacts ?? 20);
  return activeFacts
    .filter((fact) => sensitiveAllowed || !isProfileFactEffectivelySensitive(fact))
    .slice(0, maxFacts)
    .map((fact) => toReadableFact(fact));
}

export { readProfileEpisodes };

/**
 * Returns bounded non-sensitive facts that overlap the supplied continuity/entity hints.
 *
 * **Why it exists:**
 * Some continuity callers only have normalized profile state plus the current stack, so this
 * overload keeps the public seam graph-aware by creating an empty shared entity-graph snapshot
 * when the live graph is not provided explicitly.
 *
 * **What it talks to:**
 * - Uses `createEmptyEntityGraphV1` (import) from `../stage6_86EntityGraph`.
 * - Uses continuity helpers from `./profileMemoryFactContinuitySupport`.
 *
 * @param state - Loaded profile-memory state.
 * @param request - Continuity-aware fact query request.
 * @param stack - Optional current conversation stack used for scoped relevance metadata.
 * @returns Deterministically selected readable facts.
 */
export function queryProfileFactsForContinuity(
  state: ProfileMemoryState,
  request: ProfileFactContinuityQueryRequest,
  stack?: ConversationStackV1
): ProfileFactContinuityResult;

/**
 * Returns bounded non-sensitive facts that overlap the supplied continuity/entity hints.
 *
 * **Why it exists:**
 * Store and orchestration callers that already hold the shared Stage 6.86 graph should not have
 * to discard it before continuity retrieval, so this overload keeps the graph-aware seam explicit.
 *
 * **What it talks to:**
 * - Uses shared `EntityGraphV1` (import type) from `../types`.
 * - Uses continuity helpers from `./profileMemoryFactContinuitySupport`.
 *
 * @param state - Loaded profile-memory state.
 * @param graph - Current shared entity-graph snapshot used to expand continuity hints.
 * @param request - Continuity-aware fact query request.
 * @param stack - Optional current conversation stack used for scoped relevance metadata.
 * @returns Deterministically selected readable facts.
 */
export function queryProfileFactsForContinuity(
  state: ProfileMemoryState,
  graph: EntityGraphV1,
  request: ProfileFactContinuityQueryRequest,
  stack?: ConversationStackV1
): ProfileFactContinuityResult;

/**
 * Returns bounded non-sensitive facts that overlap the supplied continuity/entity hints.
 *
 * **Why it exists:**
 * Phase 6.5 cuts the continuity seam over to graph-aware hint expansion plus typed temporal
 * synthesis metadata without breaking older array-style fact consumers.
 *
 * **What it talks to:**
 * - Uses `createEmptyEntityGraphV1` (import) from `../stage6_86EntityGraph`.
 * - Uses continuity-scope helpers from `./profileMemoryContinuityScopeSupport`.
 * - Uses continuity fallback helpers from `./profileMemoryFactContinuitySupport`.
 * - Uses `queryProfileMemoryTemporalEvidence` (import) from `./profileMemoryTemporalQueries`.
 * - Uses `synthesizeProfileMemoryTemporalEvidence` (import) from `./profileMemoryTemporalSynthesis`.
 *
 * @param state - Loaded profile-memory state.
 * @param graphOrRequest - Either the shared entity graph or the continuity request.
 * @param requestOrStack - Either the continuity request or the current conversation stack.
 * @param stackOverride - Optional conversation stack when the entity graph is supplied explicitly.
 * @returns Deterministically selected readable facts plus typed continuity metadata.
 */
export function queryProfileFactsForContinuity(
  state: ProfileMemoryState,
  graphOrRequest: EntityGraphV1 | ProfileFactContinuityQueryRequest,
  requestOrStack?: ProfileFactContinuityQueryRequest | ConversationStackV1,
  stackOverride?: ConversationStackV1
): ProfileFactContinuityResult {
  const graph = isEntityGraphInput(graphOrRequest)
    ? graphOrRequest
    : createEmptyEntityGraphV1(state.updatedAt);
  const request = isEntityGraphInput(graphOrRequest)
    ? (requestOrStack as ProfileFactContinuityQueryRequest)
    : graphOrRequest;
  const stack = isEntityGraphInput(graphOrRequest)
    ? stackOverride
    : (requestOrStack as ConversationStackV1 | undefined);
  const semanticMode = request.semanticMode ?? "relationship_inventory";
  const relevanceScope = request.relevanceScope ?? "global_profile";
  const expandedEntityHints = expandProfileMemoryContinuityEntityHints(
    graph,
    Array.isArray(request.entityHints) ? request.entityHints : []
  );
  const queryInput = buildProfileMemoryContinuityScopeQueryInput(
    expandedEntityHints,
    relevanceScope,
    stack
  );
  const scopedThreadKeys = collectProfileMemoryContinuityScopedThreadKeys(stack, relevanceScope);
  if (!queryInput) {
    return buildProfileFactContinuityResult([], semanticMode, relevanceScope, scopedThreadKeys, null);
  }

  const selectedFacts = inspectProfileFactQuery(state, {
    queryInput,
    maxFacts: request.maxFacts
  }).selectedFacts;
  const temporalSlice = queryProfileMemoryTemporalEvidence(state, {
    semanticMode,
    relevanceScope,
    entityHints: expandedEntityHints,
    queryText: queryInput,
    asOfValidTime: request.asOfValidTime,
    asOfObservedTime: request.asOfObservedTime
  });
  const synthesisSlice = temporalSlice.focusEntities.length > 0
    ? temporalSlice
    : buildProfileFactContinuityFallbackTemporalSlice(selectedFacts, {
        semanticMode,
        relevanceScope,
        asOfValidTime: request.asOfValidTime,
        asOfObservedTime: request.asOfObservedTime
      });
  const temporalSynthesis =
    synthesisSlice.focusEntities.length > 0
      ? synthesizeProfileMemoryTemporalEvidence(synthesisSlice)
      : null;
  return buildProfileFactContinuityResult(
    selectedFacts,
    semanticMode,
    relevanceScope,
    scopedThreadKeys,
    temporalSynthesis
  );
}

/**
 * Builds bounded query-time proof records alongside the selected readable facts for one
 * query/planning surface.
 *
 * @param state - Loaded profile-memory state.
 * @param request - Query input plus optional as-of metadata.
 * @returns Selected facts plus deterministic query decision records.
 */
export function inspectProfileFactQuery(
  state: ProfileMemoryState,
  request: ProfileFactQueryInspectionRequest
): ProfileFactQueryInspectionResult {
  return inspectProfileFactQueryWithPolicy(state, request, false);
}

/**
 * Builds bounded query-time proof records under one explicit sensitivity posture.
 *
 * @param state - Loaded profile-memory state.
 * @param request - Query input plus optional as-of metadata.
 * @param allowSensitive - Whether effectively sensitive facts may remain visible.
 * @returns Selected facts plus deterministic query decision records.
 */
function inspectProfileFactQueryWithPolicy(
  state: ProfileMemoryState,
  request: ProfileFactQueryInspectionRequest,
  allowSensitive: boolean
): ProfileFactQueryInspectionResult {
  const selectedFactRecords = selectProfileFactsForQuery(
    state,
    Math.max(1, request.maxFacts ?? 3),
    request.queryInput,
    {
      includeSensitive: allowSensitive
    }
  );
  const selectedFactIds = new Set(selectedFactRecords.map((fact) => fact.id));
  const decisionRecords = state.facts
    .filter(
      (fact) =>
        isActiveProfileFact(fact) &&
        (allowSensitive || !isProfileFactEffectivelySensitive(fact))
    )
    .flatMap((fact) => {
      const selected = selectedFactIds.has(fact.id);
      const compatibilityVisible = isCompatibilityVisibleFactLike(fact);
      if (!selected && compatibilityVisible) {
        return [];
      }

      const decision = governProfileMemoryCandidates({
        factCandidates: [
          {
            key: fact.key,
            value: fact.value,
            sensitive: fact.sensitive,
            sourceTaskId: fact.sourceTaskId,
            source: fact.source,
            observedAt: fact.observedAt,
            confidence: fact.confidence,
            mutationAudit: fact.mutationAudit ?? null
          }
        ],
        episodeCandidates: [],
        episodeResolutionCandidates: []
      }).factDecisions[0]?.decision;

      if (!decision) {
        return [];
      }

      const familyEntry = getProfileMemoryFamilyRegistryEntry(decision.family);
      return [
        {
          family: decision.family,
          evidenceClass: decision.evidenceClass,
          governanceAction: decision.action,
          governanceReason: decision.reason,
          disposition: deriveQueryDecisionDisposition(
            decision.action,
            compatibilityVisible,
            selected,
            familyEntry.corroborationMode
          ),
          answerModeFallback: familyEntry.answerModeFallback,
          candidateRefs: [fact.id],
          evidenceRefs: [fact.id],
          asOfValidTime: request.asOfValidTime,
          asOfObservedTime: request.asOfObservedTime
        } satisfies ProfileMemoryQueryDecisionRecord
      ];
    });

  return {
    selectedFacts: selectedFactRecords.map((fact) => toReadableFact(fact)),
    decisionRecords
  };
}

/**
 * Checks whether one continuity-query argument is the shared Stage 6.86 entity graph.
 *
 * @param value - Candidate second argument supplied to `queryProfileFactsForContinuity(...)`.
 * @returns `true` when the value is an entity graph snapshot.
 */
function isEntityGraphInput(
  value: EntityGraphV1 | ProfileFactContinuityQueryRequest
): value is EntityGraphV1 {
  return "entities" in value && "edges" in value;
}
