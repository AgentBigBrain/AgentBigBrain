/**
 * @fileoverview Shared interface-runtime helpers for Stage 6.86 entity-graph reads/writes across Telegram and Discord gateways.
 */

import {
  extractEntityCandidates,
  type Stage686EntityDomainHint,
  type Stage686EntityExtractionInput,
  type Stage686EntityTypeHint
} from "../core/stage6_86EntityGraph";
import type { EntityGraphV1 } from "../core/types";
import type {
  EntityDomainHintInterpretationResolver,
  EntityTypeInterpretationResolver
} from "../organs/languageUnderstanding/localIntentModelContracts";

export interface EntityGraphStoreLike {
  getGraph(): Promise<EntityGraphV1>;
  upsertFromExtractionInput(input: Stage686EntityExtractionInput): Promise<unknown>;
}

export type InterfaceProviderId = "telegram" | "discord";

export interface InboundEntityGraphMutationInput {
  provider: InterfaceProviderId;
  conversationId: string;
  eventId: string;
  text: string;
  observedAt: string;
  domainHint?: "profile" | "relationship" | "workflow" | "system_policy" | null;
}

interface InboundEntityTypeInterpretationOptions {
  entityTypeInterpretationResolver?: EntityTypeInterpretationResolver;
  entityDomainHintInterpretationResolver?: EntityDomainHintInterpretationResolver;
}

/**
 * Resolves a dynamic-pulse graph getter bound to one shared store lifecycle.
 *
 * **Why it exists:**
 * Gateways should not create ad-hoc `EntityGraphStore` instances per read. This helper binds
 * dynamic-pulse reads to one dependency-injected store instance.
 *
 * **What it talks to:**
 * - Calls `EntityGraphStoreLike.getGraph()` when dynamic pulse is enabled.
 *
 * @param dynamicPulseEnabled - Runtime flag controlling Stage 6.86 dynamic pulse behavior.
 * @param entityGraphStore - Shared entity-graph store instance for this runtime process.
 * @returns Bound getter for scheduler reads, or undefined when dynamic pulse is disabled.
 */
export function createDynamicPulseEntityGraphGetter(
  dynamicPulseEnabled: boolean,
  entityGraphStore: EntityGraphStoreLike
): (() => Promise<EntityGraphV1>) | undefined {
  if (!dynamicPulseEnabled) {
    return undefined;
  }
  return async () => entityGraphStore.getGraph();
}

/**
 * Builds a deterministic Stage 6.86 evidence reference for interface-ingress entity mutations.
 *
 * **Why it exists:**
 * Entity-graph writes need stable, provider-scoped evidence refs so pulse/readback can be
 * audited by turn identity.
 *
 * **What it talks to:**
 * - Uses local normalization helpers in this module.
 *
 * @param provider - Interface provider that accepted the inbound message.
 * @param conversationId - Provider conversation/channel/chat identifier.
 * @param eventId - Provider update/message event identifier.
 * @returns Canonical evidence reference string.
 */
export function buildInboundEntityGraphEvidenceRef(
  provider: InterfaceProviderId,
  conversationId: string,
  eventId: string
): string {
  return [
    "interface",
    normalizeEvidenceRefSegment(provider),
    normalizeEvidenceRefSegment(conversationId),
    normalizeEvidenceRefSegment(eventId)
  ].join(":");
}

/**
 * Applies an ingress-driven entity-graph mutation when dynamic pulse mode is enabled.
 *
 * **Why it exists:**
 * Stage 6.86 graph state must be populated from real runtime traffic, not only tests/evidence
 * scripts. This helper gives both gateways one deterministic write path.
 *
 * **What it talks to:**
 * - Uses `buildInboundEntityGraphEvidenceRef(...)` for evidence linkage.
 * - Calls `EntityGraphStoreLike.upsertFromExtractionInput(...)` for persistence.
 *
 * @param entityGraphStore - Shared entity-graph store instance for this runtime process.
 * @param dynamicPulseEnabled - Runtime flag controlling whether graph mutation should run.
 * @param input - Provider-scoped ingress payload used for entity extraction/upsert.
 * @param onFailure - Optional error callback for gateway warning logs.
 * @returns `true` when mutation was attempted and succeeded; `false` when skipped or failed.
 */
export async function maybeRecordInboundEntityGraphMutation(
  entityGraphStore: EntityGraphStoreLike,
  dynamicPulseEnabled: boolean,
  input: InboundEntityGraphMutationInput,
  options: InboundEntityTypeInterpretationOptions = {},
  onFailure?: (error: Error) => void
): Promise<boolean> {
  if (!dynamicPulseEnabled) {
    return false;
  }
  try {
    const entityTypeHints = await resolveInboundEntityTypeHints(
      input,
      options.entityTypeInterpretationResolver
    );
    const entityDomainHints = await resolveInboundEntityDomainHints(
      input,
      options.entityDomainHintInterpretationResolver
    );
    await entityGraphStore.upsertFromExtractionInput({
      text: input.text,
      observedAt: input.observedAt,
      domainHint: input.domainHint ?? null,
      entityTypeHints,
      entityDomainHints,
      evidenceRef: buildInboundEntityGraphEvidenceRef(
        input.provider,
        input.conversationId,
        input.eventId
      )
    });
    return true;
  } catch (error) {
    if (onFailure) {
      onFailure(asError(error));
    }
    return false;
  }
}

const ENTITY_TYPE_RELATIONSHIP_HINT_PATTERN =
  /\b(?:friend|friends|coworker|coworkers|colleague|colleagues|teammate|teammates|mom|mother|dad|father|sister|brother|wife|husband|partner|boss|manager|boyfriend|girlfriend|married)\b/i;
const ENTITY_TYPE_ORG_HINT_PATTERN =
  /\b(?:team|company|lab|labs|group|studio|school|university|org|organization)\b/i;
const ENTITY_TYPE_EVENT_HINT_PATTERN =
  /\b(?:meeting|call|summit|conference|launch|deadline|review|checkpoint|interview|appointment)\b/i;
const ENTITY_TYPE_PLACE_HINT_PATTERN =
  /\b(?:office|park|room|city|town|street|building|campus|restaurant|cafe|airport)\b/i;
const ENTITY_TYPE_SKIP_PATTERN =
  /:\/\/|[\\/]|`|\.tsx?\b|\.jsx?\b|\b(?:npm|node|powershell|pwsh|cmd|bash|deploy|build|ship|close the browser|open the browser)\b/i;
const ENTITY_DOMAIN_RELATIONSHIP_HINT_PATTERN =
  /\b(?:friend|friends|coworker|coworkers|colleague|colleagues|teammate|teammates|boyfriend|girlfriend|partner|wife|husband|mom|mother|dad|father|sister|brother|family|roommate)\b/i;
const ENTITY_DOMAIN_PROFILE_HINT_PATTERN =
  /\b(?:i love|i like|i prefer|my favorite|favorite|hobby|hobbies|weekend|vacation|birthday|pet|dog|cat|home|apartment|cafe|coffee|restaurant)\b/i;
const ENTITY_DOMAIN_WORKFLOW_HINT_PATTERN =
  /\b(?:project|task|ticket|bug|deploy|deployment|launch|review|deadline|meeting|roadmap|spec|document|deck|customer|client|build|ship|team)\b/i;

/**
 * Resolves bounded entity-type hints for ambiguous ingress entities before persistence.
 *
 * **Why it exists:**
 * Stage 6.86 entity extraction is deterministic-first, but some inbound turns carry clear
 * conversational context that can refine entity type for request-local candidates. This helper
 * keeps that interpretation bounded, optional, and fail-closed.
 *
 * **What it talks to:**
 * - Uses deterministic candidate extraction from `extractEntityCandidates(...)`.
 * - Optionally calls the shared `EntityTypeInterpretationResolver`.
 *
 * @param input - Provider-scoped ingress payload used for entity extraction/upsert.
 * @param resolver - Optional bounded entity-type interpreter.
 * @returns Validated request-local entity-type hints or `null` when none should be applied.
 */
async function resolveInboundEntityTypeHints(
  input: InboundEntityGraphMutationInput,
  resolver?: EntityTypeInterpretationResolver
): Promise<readonly Stage686EntityTypeHint[] | null> {
  if (!resolver) {
    return null;
  }
  if (!isInboundEntityTypeInterpretationEligible(input.text)) {
    return null;
  }
  const extraction = extractEntityCandidates({
    text: input.text,
    observedAt: input.observedAt,
    evidenceRef: buildInboundEntityGraphEvidenceRef(
      input.provider,
      input.conversationId,
      input.eventId
    ),
    domainHint: input.domainHint ?? null
  });
  const candidateEntities = extraction.nodes.map((node) => ({
    candidateName: node.canonicalName,
    deterministicEntityType: node.entityType,
    domainHint: node.domainHint
  }));
  if (!candidateEntities.length || candidateEntities.every((candidate) => candidate.deterministicEntityType !== "thing")) {
    return null;
  }
  const deterministicHints = collectInboundEntityTypeDeterministicHints(input.text);
  if (deterministicHints.length === 0) {
    return null;
  }
  const interpretation = await resolver({
    userInput: input.text,
    routingClassification: null,
    sessionHints: input.domainHint
      ? {
          hasReturnHandoff: false,
          returnHandoffStatus: null,
          returnHandoffPreviewAvailable: false,
          returnHandoffPrimaryArtifactAvailable: false,
          returnHandoffChangedPathCount: 0,
          returnHandoffNextSuggestedStepAvailable: false,
          modeContinuity: null,
          domainDominantLane:
            input.domainHint === "system_policy" ? undefined : input.domainHint
        }
      : {
          hasReturnHandoff: false,
          returnHandoffStatus: null,
          returnHandoffPreviewAvailable: false,
          returnHandoffPrimaryArtifactAvailable: false,
          returnHandoffChangedPathCount: 0,
          returnHandoffNextSuggestedStepAvailable: false,
          modeContinuity: null
        },
    candidateEntities,
    deterministicHints
  });
  if (!interpretation || interpretation.kind !== "typed_candidates" || interpretation.confidence === "low") {
    return null;
  }
  return interpretation.typedCandidates.map((candidate) => ({
    candidateName: candidate.candidateName,
    entityType: candidate.entityType
  }));
}

/**
 * Resolves bounded entity-domain hints for ambiguous ingress entities before persistence.
 *
 * **Why it exists:**
 * Session-level domain is sometimes too coarse for mixed conversational turns. This helper lets
 * one bounded interpretation pass refine request-local entity observations without bypassing
 * deterministic graph merge rules.
 *
 * **What it talks to:**
 * - Uses deterministic candidate extraction from `extractEntityCandidates(...)`.
 * - Optionally calls the shared `EntityDomainHintInterpretationResolver`.
 *
 * @param input - Provider-scoped ingress payload used for entity extraction/upsert.
 * @param resolver - Optional bounded entity-domain interpreter.
 * @returns Validated request-local entity-domain hints or `null` when none should be applied.
 */
async function resolveInboundEntityDomainHints(
  input: InboundEntityGraphMutationInput,
  resolver?: EntityDomainHintInterpretationResolver
): Promise<readonly Stage686EntityDomainHint[] | null> {
  if (!resolver) {
    return null;
  }
  if (!isInboundEntityDomainInterpretationEligible(input.text)) {
    return null;
  }
  const extraction = extractEntityCandidates({
    text: input.text,
    observedAt: input.observedAt,
    evidenceRef: buildInboundEntityGraphEvidenceRef(
      input.provider,
      input.conversationId,
      input.eventId
    ),
    domainHint: input.domainHint ?? null
  });
  const candidateEntities = extraction.nodes.map((node) => ({
    candidateName: node.canonicalName,
    entityType: node.entityType,
    deterministicDomainHint:
      node.domainHint === "system_policy" ? null : node.domainHint
  }));
  if (!candidateEntities.length) {
    return null;
  }
  const deterministicHints = collectInboundEntityDomainDeterministicHints(input.text);
  if (deterministicHints.length === 0) {
    return null;
  }
  const interpretation = await resolver({
    userInput: input.text,
    routingClassification: null,
    sessionHints: input.domainHint
      ? {
          hasReturnHandoff: false,
          returnHandoffStatus: null,
          returnHandoffPreviewAvailable: false,
          returnHandoffPrimaryArtifactAvailable: false,
          returnHandoffChangedPathCount: 0,
          returnHandoffNextSuggestedStepAvailable: false,
          modeContinuity: null,
          domainDominantLane:
            input.domainHint === "system_policy" ? undefined : input.domainHint
        }
      : {
          hasReturnHandoff: false,
          returnHandoffStatus: null,
          returnHandoffPreviewAvailable: false,
          returnHandoffPrimaryArtifactAvailable: false,
          returnHandoffChangedPathCount: 0,
          returnHandoffNextSuggestedStepAvailable: false,
          modeContinuity: null
        },
    candidateEntities,
    deterministicHints
  });
  if (
    !interpretation ||
    interpretation.kind !== "domain_hinted_candidates" ||
    interpretation.confidence === "low"
  ) {
    return null;
  }
  return interpretation.domainHintedCandidates.map((candidate) => ({
    candidateName: candidate.candidateName,
    domainHint: candidate.domainHint
  }));
}

/**
 * Determines whether an inbound turn is worth bounded entity-type interpretation.
 *
 * **Why it exists:**
 * The shared conversational interpreter should only run on ambiguous entity-typing leftovers, not
 * on obvious workflow commands or every inbound chat turn.
 *
 * **What it talks to:**
 * - Uses local lexical gating only.
 *
 * @param text - Raw inbound turn text.
 * @returns `true` when the turn is eligible for optional entity-type interpretation.
 */
function isInboundEntityTypeInterpretationEligible(text: string): boolean {
  return !ENTITY_TYPE_SKIP_PATTERN.test(text);
}

/**
 * Determines whether an inbound turn is worth bounded entity-domain interpretation.
 *
 * **Why it exists:**
 * The shared conversational interpreter should only run when conversational phrasing could
 * safely refine per-entity domain beyond the session lane, not on every inbound turn.
 *
 * **What it talks to:**
 * - Uses local lexical gating only.
 *
 * @param text - Raw inbound turn text.
 * @returns `true` when the turn is eligible for optional entity-domain interpretation.
 */
function isInboundEntityDomainInterpretationEligible(text: string): boolean {
  return !ENTITY_TYPE_SKIP_PATTERN.test(text);
}

/**
 * Collects bounded deterministic hints that justify one entity-type interpretation attempt.
 *
 * **Why it exists:**
 * Slice B should remain deterministic-first. These hints keep the model path narrow by requiring
 * local evidence that the turn actually contains type-bearing context.
 *
 * **What it talks to:**
 * - Uses local hint patterns only.
 *
 * @param text - Raw inbound turn text.
 * @returns Stable bounded hint labels.
 */
function collectInboundEntityTypeDeterministicHints(text: string): readonly string[] {
  const hints: string[] = [];
  if (ENTITY_TYPE_RELATIONSHIP_HINT_PATTERN.test(text)) {
    hints.push("relationship_context");
  }
  if (ENTITY_TYPE_ORG_HINT_PATTERN.test(text)) {
    hints.push("org_context");
  }
  if (ENTITY_TYPE_EVENT_HINT_PATTERN.test(text)) {
    hints.push("event_context");
  }
  if (ENTITY_TYPE_PLACE_HINT_PATTERN.test(text)) {
    hints.push("place_context");
  }
  return hints;
}

/**
 * Collects bounded deterministic hints that justify one entity-domain interpretation attempt.
 *
 * **Why it exists:**
 * Slice B should remain deterministic-first. These hints keep the model path narrow by requiring
 * local evidence that the turn actually contains domain-bearing conversational context.
 *
 * **What it talks to:**
 * - Uses local hint patterns only.
 *
 * @param text - Raw inbound turn text.
 * @returns Stable bounded hint labels.
 */
function collectInboundEntityDomainDeterministicHints(text: string): readonly string[] {
  const hints: string[] = [];
  if (ENTITY_DOMAIN_RELATIONSHIP_HINT_PATTERN.test(text)) {
    hints.push("relationship_context");
  }
  if (ENTITY_DOMAIN_PROFILE_HINT_PATTERN.test(text)) {
    hints.push("profile_context");
  }
  if (ENTITY_DOMAIN_WORKFLOW_HINT_PATTERN.test(text)) {
    hints.push("workflow_context");
  }
  return hints;
}

/**
 * Converts unknown throwables into stable `Error` objects for logging.
 *
 * **Why it exists:**
 * Gateway warning logs should always receive `Error.message` without duplicate type guards.
 *
 * **What it talks to:**
 * - Uses local fallback conversion logic only.
 *
 * @param error - Unknown throwable captured from mutation execution.
 * @returns Normalized `Error` object.
 */
function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(typeof error === "string" ? error : "Unknown entity-graph mutation failure");
}

/**
 * Normalizes one evidence-reference segment to an ASCII-safe deterministic token.
 *
 * **Why it exists:**
 * Interface ids can contain separators or whitespace that should not alter evidence-ref shape.
 *
 * **What it talks to:**
 * - Uses local string normalization logic only.
 *
 * @param value - Raw segment value from provider/event context.
 * @returns Sanitized evidence-reference segment.
 */
function normalizeEvidenceRefSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown";
}
