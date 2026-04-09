/**
 * @fileoverview Query helpers for profile-memory planning context and readable fact access.
 */

import { type ProfileFactRecord, type ProfileMemoryState } from "../profileMemory";
import {
  buildQueryAwarePlanningContext,
  selectProfileFactsForQuery
} from "./profileMemoryPlanningContext";
import { isCompatibilityVisibleFactLike } from "./profileMemoryCompatibilityVisibility";
import { getProfileMemoryFamilyRegistryEntry } from "./profileMemoryFamilyRegistry";
import type { ProfileMemoryQueryDecisionRecord } from "./profileMemoryDecisionRecordContracts";
import { isStoredProfileFactEffectivelySensitive } from "./profileMemoryFactSensitivity";
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

export interface ProfileFactContinuityQueryRequest {
  entityHints: readonly string[];
  maxFacts?: number;
}

export interface ProfileFactQueryInspectionRequest {
  queryInput: string;
  maxFacts?: number;
  asOfValidTime?: string;
  asOfObservedTime?: string;
}

export interface ProfileFactQueryInspectionResult {
  selectedFacts: readonly ProfileReadableFact[];
  decisionRecords: readonly ProfileMemoryQueryDecisionRecord[];
}

/**
 * Builds bounded fact-review entries plus hidden decision records for one approval-aware review
 * surface.
 *
 * @param state - Loaded profile-memory state.
 * @param request - Review query plus approval and as-of controls.
 * @returns Reviewable fact entries plus hidden corroboration or fail-closed decisions.
 */
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

/**
 * Builds bounded planning-query entries plus hidden decision records for one non-mutating
 * planning or synthesis surface.
 *
 * @param state - Loaded profile-memory state.
 * @param request - Planning query plus optional as-of and sensitivity controls.
 * @returns Selected readable facts plus hidden bounded decision records.
 */
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

/**
 * Builds planner-facing profile context from normalized profile-memory state.
 *
 * @param state - Loaded profile-memory state.
 * @param maxFacts - Maximum fact count for prompt grounding.
 * @param queryInput - Current query used for relevance ranking.
 * @returns Rendered planning context string.
 */
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
  const activeFacts = state.facts
    .filter(
      (fact) =>
        isActiveProfileFact(fact) &&
        isCompatibilityVisibleFactLike(fact)
    )
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
 * @param state - Loaded profile-memory state.
 * @param request - Continuity-aware fact query request.
 * @returns Deterministically selected readable facts.
 */
export function queryProfileFactsForContinuity(
  state: ProfileMemoryState,
  request: ProfileFactContinuityQueryRequest
): readonly ProfileReadableFact[] {
  const queryInput = request.entityHints.join(" ").trim();
  if (!queryInput) {
    return [];
  }

  return inspectProfileFactQuery(state, {
    queryInput,
    maxFacts: request.maxFacts
  }).selectedFacts;
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
    .filter((fact) => isActiveProfileFact(fact) && (allowSensitive || !isProfileFactEffectivelySensitive(fact)))
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
 * Evaluates whether a profile access request includes explicit human approval metadata.
 *
 * @param request - Access request under evaluation.
 * @returns `true` when the request includes explicit approval.
 */
function isApprovalValid(request: ProfileAccessRequest): boolean {
  return (
    request.explicitHumanApproval === true &&
    typeof request.approvalId === "string" &&
    request.approvalId.trim().length > 0
  );
}

/**
 * Evaluates whether sensitive profile facts may be returned for this request.
 *
 * @param request - Access request under evaluation.
 * @returns `true` when sensitive facts may be shown.
 */
function canReadSensitiveFacts(request: ProfileAccessRequest): boolean {
  if (!request.includeSensitive) {
    return false;
  }
  if (request.purpose !== "operator_view") {
    return false;
  }
  return isApprovalValid(request);
}

/**
 * Evaluates whether a profile fact remains active for readable query surfaces.
 *
 * @param fact - Profile fact under evaluation.
 * @returns `true` when the fact is active and not superseded.
 */
function isActiveProfileFact(fact: ProfileFactRecord): boolean {
  return fact.status !== "superseded" && fact.supersededAt === null;
}

/**
 * Evaluates whether one stored fact should be treated as sensitive after the code-owned family
 * floor is enforced.
 *
 * @param fact - Stored fact under evaluation.
 * @returns `true` when the fact is effectively sensitive on bounded read/query surfaces.
 */
function isProfileFactEffectivelySensitive(fact: ProfileFactRecord): boolean {
  return isStoredProfileFactEffectivelySensitive(fact);
}

/**
 * Projects one active fact into the public readable-fact shape used by bounded review surfaces.
 *
 * @param fact - Active fact record under projection.
 * @returns Readable fact view.
 */
function toReadableFact(fact: ProfileFactRecord): ProfileReadableFact {
  return {
    factId: fact.id,
    key: fact.key,
    value: fact.value,
    status: fact.status,
    sensitive: isProfileFactEffectivelySensitive(fact),
    observedAt: fact.observedAt,
    lastUpdatedAt: fact.lastUpdatedAt,
    confidence: fact.confidence,
    mutationAudit: fact.mutationAudit
  };
}

/**
 * Recovers the backing state fact record for one readable-fact projection.
 *
 * @param state - Loaded profile-memory state.
 * @param fact - Readable fact projection.
 * @returns Backing state fact record.
 */
function toStateFactRecord(
  state: ProfileMemoryState,
  fact: ProfileReadableFact
): ProfileFactRecord {
  const stateFact = state.facts.find((entry) => entry.id === fact.factId);
  if (!stateFact) {
    throw new Error(`Readable fact ${fact.factId} is missing from profile-memory state.`);
  }
  return stateFact;
}

/**
 * Converts one governance action plus visibility posture into a bounded query-time disposition.
 *
 * @param action - Governance action assigned to the fact source.
 * @param compatibilityVisible - Whether the fact is allowed on compatibility surfaces.
 * @param selected - Whether the fact survived bounded query selection.
 * @param corroborationMode - Family-level corroboration posture.
 * @returns Deterministic query-time disposition.
 */
function deriveQueryDecisionDisposition(
  action: "allow_current_state" | "allow_episode_support" | "support_only_legacy" | "allow_end_state" | "quarantine",
  compatibilityVisible: boolean,
  selected: boolean,
  corroborationMode: "not_required" | "required_before_current_state" | "required_before_any_visibility"
): ProfileMemoryQueryDecisionRecord["disposition"] {
  if (action === "quarantine") {
    return "quarantined";
  }
  if (selected) {
    return action === "support_only_legacy"
      ? "selected_supporting_history"
      : "selected_current_state";
  }
  if (!compatibilityVisible) {
    if (corroborationMode !== "not_required") {
      return "needs_corroboration";
    }
    return "insufficient_evidence";
  }
  return "ambiguous_contested";
}
