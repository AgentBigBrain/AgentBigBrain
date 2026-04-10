/**
 * @fileoverview Shared bounded eligibility and validation helpers for entity-reference interpretation inside contextual recall.
 */

import { countLanguageTermOverlap } from "../../core/languageRuntime/languageScoring";
import type { ProfileMemoryRequestTelemetry } from "../../core/profileMemoryRuntime/contracts";
import { recordProfileMemoryAliasSafetyDecision } from "../../core/profileMemoryRuntime/profileMemoryRequestTelemetry";
import { getEntityLookupTerms } from "../../core/stage6_86/entityGraph";
import type { EntityGraphV1, EntityNodeV1 } from "../../core/types";
import {
  routeEntityReferenceInterpretationModel
} from "../../organs/languageUnderstanding/localIntentModelRouter";
import type {
  EntityReferenceInterpretationResolver,
  EntityReferenceInterpretationSignal
} from "../../organs/languageUnderstanding/localIntentModelContracts";
import type {
  ContextualReferenceResolution
} from "../../organs/languageUnderstanding/contextualReferenceResolution";
import { resolveContextualReferenceHints } from "../../organs/languageUnderstanding/contextualReferenceResolution";
import { classifyRoutingIntentV1 } from "../routingMap";
import type { ConversationSession } from "../sessionStore";
import { normalizeWhitespace } from "../conversationManagerHelpers";
import { analyzeConversationChatTurnSignals } from "./chatTurnSignals";
import { buildLocalIntentSessionHints } from "./conversationRoutingSupport";
import { resolveConversationStack, tokenizeTopicTerms } from "./contextualRecallSupport";
import type {
  ConversationEntityAliasCandidateResult,
  GetConversationEntityGraph,
  ReconcileConversationEntityAliasCandidate
} from "./managerContracts";

const MAX_ENTITY_REFERENCE_INTERPRETATION_INPUT_CHARS = 240;
const MAX_ENTITY_REFERENCE_RECENT_TURNS = 4;
const MAX_ENTITY_REFERENCE_CANDIDATES = 4;
const MAX_ENTITY_REFERENCE_HINTS = 6;
const ENTITY_ALIAS_CLARIFICATION_PATTERN =
  /\b(?:i mean|meant|actually|specifically|rather|not)\b/i;

export interface InterpretedEntityReferenceHints {
  selectedEntityKeys: readonly string[];
  selectedEntityLabels: readonly string[];
  resolvedEntityHints: readonly string[];
  explanation: string;
}

interface ResolvedEntityReferenceInterpretation {
  interpretation: EntityReferenceInterpretationSignal;
  selectedEntities: readonly EntityNodeV1[];
}

const MIN_ALIAS_RECONCILIATION_CONFIDENCE: Record<EntityReferenceInterpretationSignal["confidence"], number> = {
  low: 0,
  medium: 1,
  high: 2
};

/**
 * Deduplicates bounded lexical hints while preserving first-seen order.
 *
 * @param values - Candidate lexical values.
 * @returns Lowercased ordered unique values.
 */
function dedupeOrdered(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

/**
 * Returns whether a bounded entity-reference interpretation attempt is justified for the current turn.
 *
 * @param userInput - Raw current user wording.
 * @param session - Conversation session providing nearby turn context.
 * @param resolvedReference - Deterministic contextual-reference result for the same turn.
 * @param candidateEntities - Deterministic entity candidates already selected from the entity graph.
 * @returns `true` when the local entity-reference interpreter may be consulted.
 */
function shouldAttemptEntityReferenceInterpretation(
  userInput: string,
  session: ConversationSession,
  resolvedReference: ContextualReferenceResolution,
  candidateEntities: readonly EntityNodeV1[]
): boolean {
  const normalizedInput = normalizeWhitespace(userInput);
  if (!normalizedInput || normalizedInput.includes("\n")) {
    return false;
  }
  if (normalizedInput.length > MAX_ENTITY_REFERENCE_INTERPRETATION_INPUT_CHARS) {
    return false;
  }
  if (candidateEntities.length === 0) {
    return false;
  }
  const aliasClarificationTurn = isPlausibleEntityAliasClarificationTurn(
    userInput,
    candidateEntities
  );
  if (
    !aliasClarificationTurn &&
    !resolvedReference.usedFallbackContext &&
    resolvedReference.directTerms.length >= 2 &&
    resolvedReference.resolvedHints.length >= 2
  ) {
    return false;
  }
  const routingClassification = classifyRoutingIntentV1(normalizedInput);
  if (
    routingClassification.routeType === "execution_surface" &&
    routingClassification.commandIntent !== null
  ) {
    return false;
  }
  const signals = analyzeConversationChatTurnSignals(normalizedInput);
  if (
    signals.primaryKind === "workflow_candidate" ||
    signals.primaryKind === "approval_or_control" ||
    signals.primaryKind === "self_identity_query" ||
    signals.primaryKind === "self_identity_statement" ||
    signals.primaryKind === "assistant_identity_query"
  ) {
    return false;
  }
  if (
    !resolvedReference.hasRecallCue &&
    signals.actionability !== "recall_only" &&
    !aliasClarificationTurn
  ) {
    return false;
  }
  return session.conversationTurns.length > 0;
}

/**
 * Returns whether the current turn looks like a bounded entity-name clarification rather than a
 * recall query, while still staying narrow enough to avoid model calls on ordinary chat.
 *
 * @param userInput - Raw current user wording.
 * @param candidateEntities - Deterministic entity candidates already selected from the graph.
 * @returns `true` when the turn plausibly clarifies one candidate entity's name.
 */
function isPlausibleEntityAliasClarificationTurn(
  userInput: string,
  candidateEntities: readonly EntityNodeV1[]
): boolean {
  if (!ENTITY_ALIAS_CLARIFICATION_PATTERN.test(userInput)) {
    return false;
  }
  const queryTerms = dedupeOrdered(tokenizeTopicTerms(userInput));
  if (queryTerms.length === 0) {
    return false;
  }
  return candidateEntities.some((entity) =>
    countLanguageTermOverlap(queryTerms, getEntityLookupTerms(entity)) > 0
  );
}

/**
 * Selects the bounded deterministic entity candidates that are worth offering to the model.
 *
 * @param graph - Shared entity graph snapshot.
 * @param userInput - Raw current user wording.
 * @param resolvedReference - Deterministic contextual-reference result for the same turn.
 * @returns Ranked bounded entity candidates.
 */
function selectEntityReferenceCandidates(
  graph: EntityGraphV1,
  userInput: string,
  resolvedReference: ContextualReferenceResolution
): readonly EntityNodeV1[] {
  const normalizedInput = normalizeWhitespace(userInput).toLowerCase();
  const queryTerms = dedupeOrdered([
    ...resolvedReference.resolvedHints,
    ...tokenizeTopicTerms(userInput)
  ]);
  if (queryTerms.length === 0) {
    return [];
  }

  return [...graph.entities]
    .map((entity) => {
      const lookupTerms = getEntityLookupTerms(entity);
      const overlap = countLanguageTermOverlap(queryTerms, lookupTerms);
      const canonicalMention = normalizedInput.includes(entity.canonicalName.toLowerCase()) ? 2 : 0;
      const recencyValue = Date.parse(entity.lastSeenAt);
      const recencyWeight = Number.isFinite(recencyValue)
        ? recencyValue / 1_000_000_000_000
        : 0;
      return {
        entity,
        score: (overlap * 4) + canonicalMention + recencyWeight
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.entity.entityKey.localeCompare(right.entity.entityKey);
    })
    .slice(0, MAX_ENTITY_REFERENCE_CANDIDATES)
    .map((entry) => entry.entity);
}

/**
 * Builds bounded lexical hints from the model-selected entity nodes.
 *
 * @param selectedEntities - Entity nodes selected by the bounded interpreter.
 * @returns Stable lexical hints used by downstream deterministic recall queries.
 */
function buildResolvedEntityHints(
  selectedEntities: readonly EntityNodeV1[]
): readonly string[] {
  const merged = new Set<string>();
  for (const entity of selectedEntities) {
    for (const term of getEntityLookupTerms(entity)) {
      merged.add(term);
      if (merged.size >= MAX_ENTITY_REFERENCE_HINTS) {
        return [...merged];
      }
    }
  }
  return [...merged];
}

/**
 * Runs the bounded entity-reference interpreter and validates the selected entity subset against
 * deterministic candidate entities already present in the graph.
 *
 * @param session - Conversation session providing nearby turn context.
 * @param userInput - Raw current user wording.
 * @param resolvedReference - Deterministic contextual-reference result for the same turn.
 * @param getEntityGraph - Optional shared entity-graph getter.
 * @param resolver - Optional entity-reference interpreter.
 * @returns One validated interpretation plus the selected entity nodes, or `null` when no safe interpretation applies.
 */
async function resolveEntityReferenceInterpretation(
  session: ConversationSession,
  userInput: string,
  resolvedReference: ContextualReferenceResolution,
  getEntityGraph?: GetConversationEntityGraph,
  resolver?: EntityReferenceInterpretationResolver
): Promise<ResolvedEntityReferenceInterpretation | null> {
  if (!resolver || !getEntityGraph) {
    return null;
  }

  let graph: EntityGraphV1;
  try {
    graph = await getEntityGraph();
  } catch {
    return null;
  }
  const candidateEntities = selectEntityReferenceCandidates(graph, userInput, resolvedReference);
  if (
    !shouldAttemptEntityReferenceInterpretation(
      userInput,
      session,
      resolvedReference,
      candidateEntities
    )
  ) {
    return null;
  }

  const interpretation = await routeEntityReferenceInterpretationModel(
    {
      userInput: normalizeWhitespace(userInput),
      routingClassification: classifyRoutingIntentV1(userInput),
      sessionHints: buildLocalIntentSessionHints(session),
      recentTurns: session.conversationTurns
        .slice(-MAX_ENTITY_REFERENCE_RECENT_TURNS)
        .map((turn) => ({
          role: turn.role,
          text: normalizeWhitespace(turn.text)
        })),
      candidateEntities: candidateEntities.map((entity) => ({
        entityKey: entity.entityKey,
        canonicalName: entity.canonicalName,
        aliases: entity.aliases,
        entityType: entity.entityType,
        domainHint: entity.domainHint
      })),
      deterministicHints: resolvedReference.resolvedHints
    },
    resolver
  );

  if (
    !interpretation ||
    interpretation.selectedEntityKeys.length === 0
  ) {
    return null;
  }

  const selectedEntities = candidateEntities.filter((entity) =>
    interpretation.selectedEntityKeys.includes(entity.entityKey)
  );
  if (selectedEntities.length === 0) {
    return null;
  }

  return {
    interpretation,
    selectedEntities
  };
}

/**
 * Builds a stable trace-linked evidence ref for one conversational alias reconciliation attempt.
 *
 * @param session - Conversation session owning the turn.
 * @param observedAt - Timestamp for the current turn.
 * @param entityKey - Entity selected by deterministic validation.
 * @returns Stable evidence ref string.
 */
function buildEntityAliasEvidenceRef(
  session: ConversationSession,
  observedAt: string,
  entityKey: string
): string {
  const conversationKey = session.conversationId.includes(":")
    ? session.conversationId
    : `${session.conversationId}:${session.userId}`;
  return `conversation.entity_alias_interpretation:${conversationKey}:${observedAt}:${entityKey}`;
}

/**
 * Resolves validated model-assisted entity-reference hints for one ambiguous recall turn.
 *
 * @param session - Conversation session providing nearby turn context.
 * @param userInput - Raw current user wording.
 * @param resolvedReference - Deterministic contextual-reference result for the same turn.
 * @param getEntityGraph - Optional shared entity-graph getter.
 * @param resolver - Optional entity-reference interpreter.
 * @returns Validated model-assisted entity-reference hints, or `null` when the model should not be used.
 */
export async function resolveInterpretedEntityReferenceHints(
  session: ConversationSession,
  userInput: string,
  resolvedReference: ContextualReferenceResolution,
  getEntityGraph?: GetConversationEntityGraph,
  resolver?: EntityReferenceInterpretationResolver
): Promise<InterpretedEntityReferenceHints | null> {
  const resolved = await resolveEntityReferenceInterpretation(
    session,
    userInput,
    resolvedReference,
    getEntityGraph,
    resolver
  );
  if (
    !resolved ||
    resolved.interpretation.kind !== "entity_scoped_reference" ||
    resolved.interpretation.confidence === "low"
  ) {
    return null;
  }

  const resolvedEntityHints = buildResolvedEntityHints(resolved.selectedEntities);
  if (resolvedEntityHints.length === 0) {
    return null;
  }

  return {
    selectedEntityKeys: resolved.selectedEntities.map((entity) => entity.entityKey),
    selectedEntityLabels: resolved.selectedEntities.map((entity) => entity.canonicalName),
    resolvedEntityHints,
    explanation: resolved.interpretation.explanation
  };
}

/**
 * Reconciles one validated model-assisted alias candidate during inbound conversation handling.
 *
 * @param session - Conversation session providing prior-turn context.
 * @param userInput - Raw current user wording.
 * @param observedAt - Timestamp attached to the current inbound turn.
 * @param getEntityGraph - Optional shared entity-graph getter.
 * @param resolver - Optional entity-reference interpreter.
 * @param reconcileEntityAliasCandidate - Optional deterministic alias-reconciliation callback.
 * @returns Alias reconciliation result, or `null` when no safe alias candidate should be applied.
 */
export async function reconcileInterpretedEntityAliasCandidateForTurn(
  session: ConversationSession,
  userInput: string,
  observedAt: string,
  getEntityGraph?: GetConversationEntityGraph,
  resolver?: EntityReferenceInterpretationResolver,
  reconcileEntityAliasCandidate?: ReconcileConversationEntityAliasCandidate,
  requestTelemetry?: ProfileMemoryRequestTelemetry
): Promise<ConversationEntityAliasCandidateResult | null> {
  if (!resolver || !getEntityGraph || !reconcileEntityAliasCandidate) {
    return null;
  }
  if (!Number.isFinite(Date.parse(observedAt))) {
    return null;
  }

  const stack = resolveConversationStack(session);
  const resolvedReference = resolveContextualReferenceHints({
    userInput: normalizeWhitespace(userInput),
    recentTurns: session.conversationTurns,
    threads: stack.threads
  });
  const resolved = await resolveEntityReferenceInterpretation(
    session,
    userInput,
    resolvedReference,
    getEntityGraph,
    resolver
  );
  if (resolved?.interpretation.kind === "entity_alias_candidate") {
    recordProfileMemoryAliasSafetyDecision(requestTelemetry);
  }
  if (
    !resolved ||
    resolved.interpretation.kind !== "entity_alias_candidate" ||
    MIN_ALIAS_RECONCILIATION_CONFIDENCE[resolved.interpretation.confidence] <
      MIN_ALIAS_RECONCILIATION_CONFIDENCE.medium ||
    resolved.selectedEntities.length !== 1 ||
    !resolved.interpretation.aliasCandidate
  ) {
    return null;
  }

  return reconcileEntityAliasCandidate({
    entityKey: resolved.selectedEntities[0]!.entityKey,
    aliasCandidate: resolved.interpretation.aliasCandidate,
    observedAt,
    evidenceRef: buildEntityAliasEvidenceRef(
      session,
      observedAt,
      resolved.selectedEntities[0]!.entityKey
    )
  }).catch(() => null);
}
