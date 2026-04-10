/**
 * @fileoverview Deterministic Stage 6.86 alias-candidate validation and entity-graph reconciliation helpers.
 */

import { EntityGraphV1, EntityNodeV1, MemoryConflictCodeV1, RelationEdgeV1 } from "../types";
import { getEntityLookupTerms } from "./entityGraph";

const ENTITY_ALIAS_TOKEN_PATTERN = /^[\p{L}\p{N}]+(?:[&.'-][\p{L}\p{N}]+)*$/u;
const MAX_ENTITY_MAX_ALIASES = 64;
const ENTITY_MAX_ALIASES_DEFAULT = 8;
const MAX_VALIDATED_ENTITY_ALIAS_LENGTH = 80;
const MAX_VALIDATED_ENTITY_ALIAS_TOKENS = 6;

export interface Stage686AliasConflict {
  conflictCode: Extract<MemoryConflictCodeV1, "ALIAS_COLLISION">;
  alias: string;
  existingEntityKey: string;
  incomingEntityKey: string;
}

export interface Stage686EntityAliasCandidateInput {
  entityKey: string;
  aliasCandidate: string;
  observedAt: string;
  evidenceRef: string;
}

export interface Stage686EntityAliasMutationOptions {
  entityMaxAliases?: number;
}

export interface Stage686EntityAliasMutationResult {
  graph: EntityGraphV1;
  entityKey: string;
  acceptedAlias: string | null;
  aliasConflicts: readonly Stage686AliasConflict[];
  rejectionReason:
    | "ENTITY_NOT_FOUND"
    | "INVALID_ALIAS_CANDIDATE"
    | "ALIAS_ALREADY_PRESENT"
    | "ALIAS_COLLISION"
    | "ALIAS_NO_TERM_OVERLAP"
    | null;
}

/**
 * Applies deterministic validity checks for valid iso timestamp.
 *
 * **Why it exists:**
 * Fails fast when valid iso timestamp is invalid so later control flow stays safe and predictable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fieldName - Value for field name.
 */
function assertValidIsoTimestamp(value: string, fieldName: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`Invalid ISO timestamp for ${fieldName}: ${value}`);
  }
}

/**
 * Normalizes whitespace into a stable shape for alias-reconciliation logic.
 *
 * **Why it exists:**
 * Centralizes whitespace cleanup so validation and persistence agree on one canonical alias form.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Normalizes alias key into a stable shape for alias ownership checks.
 *
 * **Why it exists:**
 * Keeps collision detection deterministic regardless of punctuation or casing drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function normalizeAliasKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Merges string lists into a stable bounded ordered collection.
 *
 * **Why it exists:**
 * Reuses the same dedupe/ordering contract for aliases and evidence refs within alias reconciliation.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param left - Existing values.
 * @param right - Incoming values.
 * @param limit - Maximum number of values to keep.
 * @returns Ordered collection produced by this step.
 */
function mergeStringList(left: readonly string[], right: readonly string[], limit: number): readonly string[] {
  const boundedLimit = Math.max(1, Math.min(MAX_ENTITY_MAX_ALIASES, Math.floor(limit)));
  const merged = new Map<string, string>();
  for (const entry of [...left, ...right]) {
    const normalized = normalizeWhitespace(entry);
    if (!normalized) {
      continue;
    }
    const key = normalizeAliasKey(normalized);
    if (!key || merged.has(key)) {
      continue;
    }
    merged.set(key, normalized);
  }
  return [...merged.values()].sort((a, b) => a.localeCompare(b)).slice(0, boundedLimit);
}

/**
 * Sorts entity nodes into stable entity-key order.
 *
 * **Why it exists:**
 * Preserves deterministic graph snapshots after alias reconciliation mutates one entity.
 *
 * **What it talks to:**
 * - Uses `EntityNodeV1` (import `EntityNodeV1`) from `../types`.
 *
 * @param nodes - Entity collection to order.
 * @returns Ordered collection produced by this step.
 */
function sortEntityNodes(nodes: readonly EntityNodeV1[]): readonly EntityNodeV1[] {
  return [...nodes].sort((left, right) => left.entityKey.localeCompare(right.entityKey));
}

/**
 * Sorts relation edges into stable edge-key order.
 *
 * **Why it exists:**
 * Preserves deterministic graph snapshots after alias reconciliation carries forward unchanged edges.
 *
 * **What it talks to:**
 * - Uses `RelationEdgeV1` (import `RelationEdgeV1`) from `../types`.
 *
 * @param edges - Edge collection to order.
 * @returns Ordered collection produced by this step.
 */
function sortRelationEdges(edges: readonly RelationEdgeV1[]): readonly RelationEdgeV1[] {
  return [...edges].sort((left, right) => left.edgeKey.localeCompare(right.edgeKey));
}

/**
 * Builds alias-owner lookup from the current entity graph snapshot.
 *
 * **Why it exists:**
 * Centralizes alias ownership indexing so alias reconciliation uses one collision policy.
 *
 * **What it talks to:**
 * - Uses `EntityGraphV1` (import `EntityGraphV1`) from `../types`.
 * - Uses local constants/helpers within this module.
 *
 * @param graph - Current entity graph snapshot.
 * @returns Stable alias-owner index for this graph.
 */
function buildAliasOwnerIndex(graph: EntityGraphV1): Map<string, string> {
  const aliasIndex = new Map<string, string>();
  for (const entity of graph.entities) {
    aliasIndex.set(normalizeAliasKey(entity.canonicalName), entity.entityKey);
    for (const alias of entity.aliases) {
      aliasIndex.set(normalizeAliasKey(alias), entity.entityKey);
    }
  }
  return aliasIndex;
}

/**
 * Validates one model-proposed alias candidate for deterministic-safe reconciliation.
 *
 * **Why it exists:**
 * Keeps structural alias safety rules explicit before any graph mutation can happen, so the model
 * never writes arbitrary conversational payloads into entity aliases.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param candidateValue - Raw alias candidate proposed by a bounded interpreter.
 * @returns Canonical alias text when accepted, otherwise `null`.
 */
export function validateEntityAliasCandidateValue(candidateValue: string | null): string | null {
  const normalized = normalizeWhitespace(candidateValue ?? "");
  if (
    !normalized ||
    normalized.length > MAX_VALIDATED_ENTITY_ALIAS_LENGTH ||
    /[\r\n\\/]/.test(normalized) ||
    /\b(?:https?:\/\/|file:\/\/\/)\b/i.test(normalized) ||
    /[`$=<>{}\[\]()]/.test(normalized)
  ) {
    return null;
  }
  const tokens = normalized.split(" ");
  return tokens.length > 0 &&
    tokens.length <= MAX_VALIDATED_ENTITY_ALIAS_TOKENS &&
    tokens.every((token) => ENTITY_ALIAS_TOKEN_PATTERN.test(token))
    ? normalized
    : null;
}

/**
 * Returns whether one validated alias candidate still overlaps the entity's known lookup surface.
 *
 * **Why it exists:**
 * Adds one conservative deterministic guard so alias reconciliation only broadens an entity using
 * wording that still intersects that entity's current canonical or alias vocabulary.
 *
 * **What it talks to:**
 * - Uses `EntityNodeV1` (import `EntityNodeV1`) from `../types`.
 * - Uses `getEntityLookupTerms(...)` (import `getEntityLookupTerms`) from `./entityGraph`.
 *
 * @param entity - Existing entity targeted for alias reconciliation.
 * @param aliasCandidate - Deterministically validated alias candidate.
 * @returns `true` when the alias shares at least one lookup term with the entity.
 */
function hasEntityAliasTermOverlap(entity: EntityNodeV1, aliasCandidate: string): boolean {
  const entityTerms = new Set(getEntityLookupTerms(entity));
  for (const term of getEntityLookupTerms({ canonicalName: aliasCandidate, aliases: [aliasCandidate] })) {
    if (entityTerms.has(term)) {
      return true;
    }
  }
  return false;
}

/**
 * Applies one validated alias candidate to an existing entity graph snapshot.
 *
 * **Why it exists:**
 * Gives higher-level runtime seams one deterministic alias-reconciliation contract that preserves
 * collision checks, evidence merging, and bounded alias growth without re-implementing graph
 * mutation logic outside Stage 6.86.
 *
 * **What it talks to:**
 * - Uses `EntityGraphV1` (import `EntityGraphV1`) from `../types`.
 * - Uses local constants/helpers within this module.
 *
 * @param graph - Current entity graph snapshot.
 * @param input - Alias candidate and provenance for this mutation.
 * @param options - Optional tuning knobs for entity alias caps.
 * @returns Alias-reconciliation result including accepted alias or deterministic rejection reason.
 */
export function applyEntityAliasCandidateToGraph(
  graph: EntityGraphV1,
  input: Stage686EntityAliasCandidateInput,
  options: Stage686EntityAliasMutationOptions = {}
): Stage686EntityAliasMutationResult {
  assertValidIsoTimestamp(input.observedAt, "observedAt");
  const entityMaxAliases = options.entityMaxAliases ?? ENTITY_MAX_ALIASES_DEFAULT;
  const entities = new Map<string, EntityNodeV1>(graph.entities.map((entity) => [entity.entityKey, { ...entity }]));
  const candidate = entities.get(input.entityKey);
  if (!candidate) {
    return { graph, entityKey: input.entityKey, acceptedAlias: null, aliasConflicts: [], rejectionReason: "ENTITY_NOT_FOUND" };
  }

  const validatedAlias = validateEntityAliasCandidateValue(input.aliasCandidate);
  if (!validatedAlias) {
    return { graph, entityKey: input.entityKey, acceptedAlias: null, aliasConflicts: [], rejectionReason: "INVALID_ALIAS_CANDIDATE" };
  }
  if (!hasEntityAliasTermOverlap(candidate, validatedAlias)) {
    return { graph, entityKey: input.entityKey, acceptedAlias: null, aliasConflicts: [], rejectionReason: "ALIAS_NO_TERM_OVERLAP" };
  }

  const aliasOwner = buildAliasOwnerIndex(graph).get(normalizeAliasKey(validatedAlias));
  if (aliasOwner === input.entityKey) {
    return { graph, entityKey: input.entityKey, acceptedAlias: null, aliasConflicts: [], rejectionReason: "ALIAS_ALREADY_PRESENT" };
  }
  if (aliasOwner && aliasOwner !== input.entityKey) {
    return {
      graph,
      entityKey: input.entityKey,
      acceptedAlias: null,
      aliasConflicts: [{
        conflictCode: "ALIAS_COLLISION",
        alias: validatedAlias,
        existingEntityKey: aliasOwner,
        incomingEntityKey: input.entityKey
      }],
      rejectionReason: "ALIAS_COLLISION"
    };
  }

  entities.set(candidate.entityKey, {
    ...candidate,
    aliases: mergeStringList(candidate.aliases, [validatedAlias], Math.max(1, Math.min(MAX_ENTITY_MAX_ALIASES, Math.floor(entityMaxAliases)))),
    lastSeenAt: input.observedAt,
    salience: Math.max(1, Number((candidate.salience + 1).toFixed(4))),
    evidenceRefs: mergeStringList(candidate.evidenceRefs, [input.evidenceRef], 64)
  });
  return {
    graph: {
      schemaVersion: "v1",
      updatedAt: input.observedAt,
      entities: sortEntityNodes([...entities.values()]),
      edges: sortRelationEdges([...graph.edges]),
      decisionRecords: graph.decisionRecords ?? []
    },
    entityKey: input.entityKey,
    acceptedAlias: validatedAlias,
    aliasConflicts: [],
    rejectionReason: null
  };
}
