/**
 * @fileoverview Deterministic Stage 6.86 entity extraction and relationship graph helpers for checkpoints 6.86.A and 6.86.B.
 */

import {
  BridgeConflictCodeV1,
  EntityGraphV1,
  EntityNodeV1,
  EntityTypeV1,
  MemoryConflictCodeV1,
  MemoryStatusV1,
  RelationEdgeV1,
  RelationTypeV1
} from "../types";
import { sha256HexFromCanonicalJson } from "../normalizers/canonicalizationRules";

const ENTITY_PATTERN = /\b[A-Z][A-Za-z0-9'._-]*(?:\s+[A-Z][A-Za-z0-9'._-]*){0,3}\b/g;
const ENTITY_STOP_WORDS = new Set([
  "The",
  "A",
  "An",
  "And",
  "Can",
  "Could",
  "Do",
  "Does",
  "Did",
  "Explain",
  "How",
  "Or",
  "But",
  "If",
  "So",
  "Then",
  "When",
  "Who",
  "What",
  "Where",
  "Why",
  "These",
  "This",
  "Those",
  "Relationships",
  "Relationship",
  "While",
  "Today",
  "Tomorrow",
  "Yesterday",
  "BigBrain",
  "AgentBigBrain"
]);
const ORG_HINT_PATTERN = /\b(?:inc|llc|ltd|corp|company|studio|labs|systems|group|school|university)\b/i;
const EVENT_HINT_PATTERN = /\b(?:meeting|review|launch|summit|conference|checkpoint|deadline)\b/i;
const MAX_ENTITY_MAX_ALIASES = 64;
const MAX_GRAPH_EDGES_PER_ENTITY_DEFAULT = 200;
const ENTITY_MAX_ALIASES_DEFAULT = 8;
const CO_MENTION_RECENCY_HALFLIFE_DAYS = 30;
const ENTITY_DOMAIN_HINTS = ["profile", "relationship", "workflow", "system_policy"] as const;

export interface Stage686EntityExtractionInput {
  text: string;
  observedAt: string;
  evidenceRef: string;
  domainHint?: "profile" | "relationship" | "workflow" | "system_policy" | null;
  entityTypeHints?: readonly Stage686EntityTypeHint[] | null;
  entityDomainHints?: readonly Stage686EntityDomainHint[] | null;
}

export interface Stage686EntityExtractionResult {
  nodes: readonly EntityNodeV1[];
  coMentionPairs: readonly Readonly<[string, string]>[];
}

export interface Stage686EntityTypeHint {
  candidateName: string;
  entityType: EntityTypeV1;
}

export interface Stage686EntityDomainHint {
  candidateName: string;
  domainHint: Extract<EntityNodeV1["domainHint"], "profile" | "relationship" | "workflow">;
}

export interface Stage686AliasConflict {
  conflictCode: Extract<MemoryConflictCodeV1, "ALIAS_COLLISION">;
  alias: string;
  existingEntityKey: string;
  incomingEntityKey: string;
}

export interface Stage686EntityGraphMutationOptions {
  entityMaxAliases?: number;
  maxGraphEdgesPerEntity?: number;
}

export interface Stage686EntityGraphMutationResult {
  graph: EntityGraphV1;
  acceptedEntityKeys: readonly string[];
  aliasConflicts: readonly Stage686AliasConflict[];
  evictedEdgeKeys: readonly string[];
}

export interface Stage686RelationPromotionInput {
  sourceEntityKey: string;
  targetEntityKey: string;
  relationType: Exclude<RelationTypeV1, "co_mentioned" | "unknown">;
  explicitUserConfirmation: boolean;
  observedAt: string;
  evidenceRef: string;
}

export interface Stage686RelationPromotionResult {
  graph: EntityGraphV1;
  promoted: boolean;
  deniedConflictCode: BridgeConflictCodeV1 | null;
  edgeKey: string | null;
}

/**
 * Builds deterministic lookup terms for one entity graph node.
 *
 * @param entity - Entity node to normalize.
 * @returns Stable lookup terms for continuity linkage.
 */
export function getEntityLookupTerms(
  entity: Pick<EntityNodeV1, "canonicalName" | "aliases">
): readonly string[] {
  const normalized = new Set<string>();
  for (const value of [entity.canonicalName, ...entity.aliases]) {
    for (const term of normalizeAliasKey(value).split(" ")) {
      if (term.trim().length >= 3) {
        normalized.add(term.trim());
      }
    }
  }
  return [...normalized].sort((left, right) => left.localeCompare(right));
}

/**
 * Returns entity nodes whose canonical name or accepted alias exactly matches one candidate label.
 *
 * @param graph - Shared Stage 6.86 entity graph snapshot.
 * @param candidateName - Bounded visible-name candidate to resolve.
 * @returns Stable ordered entity matches, or an empty array when no exact match exists.
 */
export function queryEntityGraphNodesByCanonicalOrAlias(
  graph: EntityGraphV1,
  candidateName: string
): readonly EntityNodeV1[] {
  const normalizedCandidate = normalizeAliasKey(candidateName);
  if (!normalizedCandidate) {
    return [];
  }
  return sortEntityNodes(
    graph.entities.filter((entity) =>
      normalizeAliasKey(entity.canonicalName) === normalizedCandidate ||
      entity.aliases.some((alias) => normalizeAliasKey(alias) === normalizedCandidate)
    )
  );
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
 * Normalizes whitespace into a stable shape for `stage6_86EntityGraph` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for whitespace so call sites stay aligned.
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
 * Normalizes alias key into a stable shape for `stage6_86EntityGraph` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for alias key so call sites stay aligned.
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
 * Normalizes a candidate session-domain hint into the supported entity-domain subset.
 *
 * **Why it exists:**
 * Keeps ingress-carried domain hints bounded to the shared lane contract so entity persistence
 * does not accumulate arbitrary free-form tags.
 *
 * **What it talks to:**
 * - Uses local allowed-value constants in this module.
 *
 * @param value - Candidate domain hint from interface/runtime context.
 * @returns Normalized domain hint or `null` when absent/unsupported.
 */
function normalizeEntityDomainHint(
  value: unknown
): EntityNodeV1["domainHint"] {
  return typeof value === "string" &&
    (ENTITY_DOMAIN_HINTS as readonly string[]).includes(value)
    ? (value as EntityNodeV1["domainHint"])
    : null;
}

/**
 * Merges a persisted and incoming entity-domain hint without creating hard partitions.
 *
 * **Why it exists:**
 * Entity ingress can observe the same entity across personal and workflow sessions. When that
 * evidence conflicts, the safer deterministic shape is to degrade the hint to `null`.
 *
 * **What it talks to:**
 * - Uses normalized domain-hint labels only.
 *
 * @param existing - Previously persisted domain hint.
 * @param incoming - Newly observed domain hint.
 * @returns The reconciled domain hint for the entity node.
 */
function mergeEntityDomainHint(
  existing: Stage686EntityExtractionInput["domainHint"],
  incoming: Stage686EntityExtractionInput["domainHint"]
): EntityNodeV1["domainHint"] {
  const normalizedExisting = normalizeEntityDomainHint(existing);
  const normalizedIncoming = normalizeEntityDomainHint(incoming);
  if (!normalizedExisting) {
    return normalizedIncoming;
  }
  if (!normalizedIncoming) {
    return normalizedExisting;
  }
  return normalizedExisting === normalizedIncoming ? normalizedExisting : null;
}

/**
 * Converts values into canonical name form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for canonical name deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param raw - Value for raw.
 * @returns Resulting string value.
 */
function toCanonicalName(raw: string): string {
  const normalized = normalizeEntityCandidate(raw);
  if (!normalized) {
    return "";
  }
  return normalized
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Derives entity type from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for entity type in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses `EntityTypeV1` (import `EntityTypeV1`) from `./types`.
 *
 * @param raw - Value for raw.
 * @returns Computed `EntityTypeV1` result.
 */
function deriveEntityType(raw: string): EntityTypeV1 {
  if (ORG_HINT_PATTERN.test(raw)) {
    return "org";
  }
  if (EVENT_HINT_PATTERN.test(raw)) {
    return "event";
  }

  if (raw.split(" ").length >= 2) {
    return "person";
  }

  return "thing";
}

/**
 * Normalizes one raw regex entity match into a bounded candidate name, dropping clause-boundary
 * fragments and leading conversational glue so the graph does not persist junk entities.
 *
 * @param raw - Raw regex entity match candidate.
 * @returns Bounded canonicalizable entity text, or an empty string when the match is not safe.
 */
function normalizeEntityCandidate(raw: string): string {
  const normalized = normalizeWhitespace(raw);
  if (!normalized) {
    return "";
  }
  if (/[.!?]\s+[A-Z]/.test(normalized)) {
    return "";
  }
  const cleanedTokens = normalized
    .split(" ")
    .map((token) => token.replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, ""))
    .filter(Boolean);
  while (cleanedTokens.length > 0 && ENTITY_STOP_WORDS.has(cleanedTokens[0])) {
    cleanedTokens.shift();
  }
  while (
    cleanedTokens.length > 0 &&
    ENTITY_STOP_WORDS.has(cleanedTokens[cleanedTokens.length - 1])
  ) {
    cleanedTokens.pop();
  }
  return normalizeWhitespace(cleanedTokens.join(" "));
}

/**
 * Builds a bounded lookup map for validated interpreted entity-type hints.
 *
 * **Why it exists:**
 * Shared conversational interpretation may supply higher-precision type hints for deterministic
 * request-local candidates. This helper keeps that input bounded and normalized before extraction.
 *
 * **What it talks to:**
 * - Uses local normalization helpers and `EntityTypeV1`.
 *
 * @param value - Optional validated entity-type hints carried with one extraction request.
 * @returns Normalized candidate-name -> entity-type map.
 */
function buildEntityTypeHintMap(
  value: readonly Stage686EntityTypeHint[] | null | undefined
): ReadonlyMap<string, EntityTypeV1> {
  const mapped = new Map<string, EntityTypeV1>();
  for (const hint of value ?? []) {
    if (!hint || typeof hint !== "object") {
      continue;
    }
    const candidateName = toCanonicalName(String(hint.candidateName ?? ""));
    const normalizedKey = normalizeAliasKey(candidateName);
    if (!normalizedKey) {
      continue;
    }
    if (![
      "person",
      "place",
      "org",
      "event",
      "thing",
      "concept"
    ].includes(String(hint.entityType ?? ""))) {
      continue;
    }
    if (!mapped.has(normalizedKey)) {
      mapped.set(normalizedKey, hint.entityType);
    }
  }
  return mapped;
}

/**
 * Builds a bounded lookup map for validated interpreted entity-domain hints.
 *
 * **Why it exists:**
 * Shared conversational interpretation may supply higher-precision per-observation domain hints
 * for deterministic request-local candidates. This helper keeps that input bounded and normalized
 * before extraction.
 *
 * **What it talks to:**
 * - Uses local normalization helpers and entity-domain allowed values.
 *
 * @param value - Optional validated entity-domain hints carried with one extraction request.
 * @returns Normalized candidate-name -> domain-hint map.
 */
function buildEntityDomainHintMap(
  value: readonly Stage686EntityDomainHint[] | null | undefined
): ReadonlyMap<string, Extract<EntityNodeV1["domainHint"], "profile" | "relationship" | "workflow">> {
  const mapped = new Map<
    string,
    Extract<EntityNodeV1["domainHint"], "profile" | "relationship" | "workflow">
  >();
  for (const hint of value ?? []) {
    if (!hint || typeof hint !== "object") {
      continue;
    }
    const candidateName = toCanonicalName(String(hint.candidateName ?? ""));
    const normalizedKey = normalizeAliasKey(candidateName);
    const domainHint = normalizeEntityDomainHint(hint.domainHint);
    if (!normalizedKey || !domainHint || domainHint === "system_policy") {
      continue;
    }
    if (!mapped.has(normalizedKey)) {
      mapped.set(normalizedKey, domainHint);
    }
  }
  return mapped;
}

/**
 * Builds entity key for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of entity key consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `sha256HexFromCanonicalJson` (import `sha256HexFromCanonicalJson`) from `./normalizers/canonicalizationRules`.
 * - Uses `EntityTypeV1` (import `EntityTypeV1`) from `./types`.
 *
 * @param canonicalName - Boolean gate controlling this branch.
 * @param entityType - Value for entity type.
 * @param disambiguator - Value for disambiguator.
 * @returns Resulting string value.
 */
export function buildEntityKey(
  canonicalName: string,
  entityType: EntityTypeV1,
  disambiguator: string | null = null
): string {
  const fingerprint = sha256HexFromCanonicalJson({
    canonicalName: normalizeAliasKey(canonicalName),
    entityType,
    disambiguator: disambiguator ?? ""
  });
  return `entity_${fingerprint.slice(0, 20)}`;
}

/**
 * Builds edge key for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of edge key consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `sha256HexFromCanonicalJson` (import `sha256HexFromCanonicalJson`) from `./normalizers/canonicalizationRules`.
 *
 * @param sourceEntityKey - Lookup key or map field identifier.
 * @param targetEntityKey - Lookup key or map field identifier.
 * @returns Resulting string value.
 */
function buildEdgeKey(sourceEntityKey: string, targetEntityKey: string): string {
  const ordered =
    sourceEntityKey.localeCompare(targetEntityKey) <= 0
      ? [sourceEntityKey, targetEntityKey]
      : [targetEntityKey, sourceEntityKey];
  const fingerprint = sha256HexFromCanonicalJson({ ordered });
  return `edge_${fingerprint.slice(0, 20)}`;
}

/**
 * Derives co mention increment from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for co mention increment in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param lastObservedAt - Timestamp used for ordering, timeout, or recency decisions.
 * @param observedAt - Timestamp used for ordering, timeout, or recency decisions.
 * @returns Computed numeric value.
 */
export function computeCoMentionIncrement(lastObservedAt: string, observedAt: string): number {
  assertValidIsoTimestamp(lastObservedAt, "lastObservedAt");
  assertValidIsoTimestamp(observedAt, "observedAt");
  const lastObservedAtMs = Date.parse(lastObservedAt);
  const observedAtMs = Date.parse(observedAt);
  const deltaDays = Math.max(0, (observedAtMs - lastObservedAtMs) / (24 * 60 * 60 * 1_000));
  const decayFactor = Math.pow(0.5, deltaDays / CO_MENTION_RECENCY_HALFLIFE_DAYS);
  return Number(Math.max(0.05, decayFactor).toFixed(4));
}

/**
 * Normalizes ordering and duplication for string list.
 *
 * **Why it exists:**
 * Maintains stable ordering and deduplication rules for string list in one place.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param left - Value for left.
 * @param right - Value for right.
 * @param limit - Numeric bound, counter, or index used by this logic.
 * @returns Ordered collection produced by this step.
 */
function mergeStringList(
  left: readonly string[],
  right: readonly string[],
  limit: number
): readonly string[] {
  const boundedLimit = Math.max(1, Math.min(MAX_ENTITY_MAX_ALIASES, Math.floor(limit)));
  const merged = new Map<string, string>();
  for (const entry of [...left, ...right]) {
    const normalized = normalizeWhitespace(entry);
    if (!normalized) {
      continue;
    }
    const key = normalizeAliasKey(normalized);
    if (!key) {
      continue;
    }
    if (!merged.has(key)) {
      merged.set(key, normalized);
    }
  }

  return [...merged.values()]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, boundedLimit);
}

/**
 * Normalizes ordering and duplication for entity nodes.
 *
 * **Why it exists:**
 * Maintains stable ordering and deduplication rules for entity nodes in one place.
 *
 * **What it talks to:**
 * - Uses `EntityNodeV1` (import `EntityNodeV1`) from `./types`.
 *
 * @param nodes - Value for nodes.
 * @returns Ordered collection produced by this step.
 */
function sortEntityNodes(nodes: readonly EntityNodeV1[]): readonly EntityNodeV1[] {
  return [...nodes].sort((left, right) => left.entityKey.localeCompare(right.entityKey));
}

/**
 * Normalizes ordering and duplication for relation edges.
 *
 * **Why it exists:**
 * Maintains stable ordering and deduplication rules for relation edges in one place.
 *
 * **What it talks to:**
 * - Uses `RelationEdgeV1` (import `RelationEdgeV1`) from `./types`.
 *
 * @param edges - Value for edges.
 * @returns Ordered collection produced by this step.
 */
function sortRelationEdges(edges: readonly RelationEdgeV1[]): readonly RelationEdgeV1[] {
  return [...edges].sort((left, right) => left.edgeKey.localeCompare(right.edgeKey));
}

/**
 * Builds empty entity graph v1 for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of empty entity graph v1 consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `EntityGraphV1` (import `EntityGraphV1`) from `./types`.
 *
 * @param updatedAt - Timestamp used for ordering, timeout, or recency decisions.
 * @returns Computed `EntityGraphV1` result.
 */
export function createEmptyEntityGraphV1(updatedAt: string): EntityGraphV1 {
  assertValidIsoTimestamp(updatedAt, "updatedAt");
  return {
    schemaVersion: "v1",
    updatedAt,
    entities: [],
    edges: [],
    decisionRecords: []
  };
}

/**
 * Derives entity candidates from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for entity candidates in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses `EntityNodeV1` (import `EntityNodeV1`) from `./types`.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `Stage686EntityExtractionResult` result.
 */
export function extractEntityCandidates(
  input: Stage686EntityExtractionInput
): Stage686EntityExtractionResult {
  assertValidIsoTimestamp(input.observedAt, "observedAt");
  const text = normalizeWhitespace(input.text);
  if (!text) {
    return {
      nodes: [],
      coMentionPairs: []
    };
  }

  const nodesByKey = new Map<string, EntityNodeV1>();
  const normalizedDomainHint = normalizeEntityDomainHint(input.domainHint);
  const entityTypeHintMap = buildEntityTypeHintMap(input.entityTypeHints);
  const entityDomainHintMap = buildEntityDomainHintMap(input.entityDomainHints);
  const matches = text.match(ENTITY_PATTERN) ?? [];
  for (const match of matches) {
    const canonicalName = toCanonicalName(match);
    if (!canonicalName || ENTITY_STOP_WORDS.has(canonicalName)) {
      continue;
    }

    const entityType =
      entityTypeHintMap.get(normalizeAliasKey(canonicalName)) ?? deriveEntityType(canonicalName);
    const resolvedDomainHint =
      entityDomainHintMap.get(normalizeAliasKey(canonicalName)) ?? normalizedDomainHint;
    const entityKey = buildEntityKey(canonicalName, entityType, null);
    if (nodesByKey.has(entityKey)) {
      continue;
    }

    nodesByKey.set(entityKey, {
      entityKey,
      canonicalName,
      entityType,
      disambiguator: null,
      domainHint: resolvedDomainHint,
      aliases: [canonicalName],
      firstSeenAt: input.observedAt,
      lastSeenAt: input.observedAt,
      salience: 1,
      evidenceRefs: [input.evidenceRef]
    });
  }

  const orderedEntityKeys = [...nodesByKey.keys()].sort((left, right) => left.localeCompare(right));
  const coMentionPairs: Readonly<[string, string]>[] = [];
  for (let index = 0; index < orderedEntityKeys.length; index += 1) {
    for (let next = index + 1; next < orderedEntityKeys.length; next += 1) {
      coMentionPairs.push([orderedEntityKeys[index], orderedEntityKeys[next]]);
    }
  }

  return {
    nodes: sortEntityNodes([...nodesByKey.values()]),
    coMentionPairs
  };
}

/**
 * Executes entity extraction to graph as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the entity extraction to graph runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses `EntityGraphV1` (import `EntityGraphV1`) from `./types`.
 * - Uses `EntityNodeV1` (import `EntityNodeV1`) from `./types`.
 * - Uses `MemoryStatusV1` (import `MemoryStatusV1`) from `./types`.
 * - Uses `RelationEdgeV1` (import `RelationEdgeV1`) from `./types`.
 * - Uses `RelationTypeV1` (import `RelationTypeV1`) from `./types`.
 *
 * @param graph - Value for graph.
 * @param extraction - Value for extraction.
 * @param observedAt - Timestamp used for ordering, timeout, or recency decisions.
 * @param evidenceRef - Stable identifier used to reference an entity or record.
 * @param options - Optional tuning knobs for this operation.
 * @returns Computed `Stage686EntityGraphMutationResult` result.
 */
export function applyEntityExtractionToGraph(
  graph: EntityGraphV1,
  extraction: Stage686EntityExtractionResult,
  observedAt: string,
  evidenceRef: string,
  options: Stage686EntityGraphMutationOptions = {}
): Stage686EntityGraphMutationResult {
  assertValidIsoTimestamp(observedAt, "observedAt");
  const entityMaxAliases = options.entityMaxAliases ?? ENTITY_MAX_ALIASES_DEFAULT;
  const maxGraphEdgesPerEntity = options.maxGraphEdgesPerEntity ?? MAX_GRAPH_EDGES_PER_ENTITY_DEFAULT;

  const entities = new Map<string, EntityNodeV1>(
    graph.entities.map((entity) => [entity.entityKey, { ...entity }])
  );
  const edges = new Map<string, RelationEdgeV1>(graph.edges.map((edge) => [edge.edgeKey, { ...edge }]));
  const aliasIndex = new Map<string, string>();
  const acceptedEntityKeys: string[] = [];
  const aliasConflicts: Stage686AliasConflict[] = [];

  for (const entity of entities.values()) {
    aliasIndex.set(normalizeAliasKey(entity.canonicalName), entity.entityKey);
    for (const alias of entity.aliases) {
      aliasIndex.set(normalizeAliasKey(alias), entity.entityKey);
    }
  }

  for (const incoming of extraction.nodes) {
    const existing = entities.get(incoming.entityKey);
    const candidate = existing
      ? { ...existing }
      : {
          ...incoming,
          firstSeenAt: observedAt,
          lastSeenAt: observedAt,
          domainHint: normalizeEntityDomainHint(incoming.domainHint),
          evidenceRefs: [evidenceRef]
        };

    const mergedAliases = mergeStringList(
      candidate.aliases,
      incoming.aliases,
      Math.max(1, Math.min(MAX_ENTITY_MAX_ALIASES, Math.floor(entityMaxAliases)))
    );

    const acceptedAliases: string[] = [];
    for (const alias of mergedAliases) {
      const aliasKey = normalizeAliasKey(alias);
      if (!aliasKey) {
        continue;
      }
      const owner = aliasIndex.get(aliasKey);
      if (owner && owner !== candidate.entityKey) {
        aliasConflicts.push({
          conflictCode: "ALIAS_COLLISION",
          alias,
          existingEntityKey: owner,
          incomingEntityKey: candidate.entityKey
        });
        continue;
      }
      aliasIndex.set(aliasKey, candidate.entityKey);
      acceptedAliases.push(alias);
    }

    const mergedEvidenceRefs = mergeStringList(candidate.evidenceRefs, [evidenceRef], 64);
    entities.set(candidate.entityKey, {
      ...candidate,
      domainHint: mergeEntityDomainHint(candidate.domainHint, incoming.domainHint),
      aliases: acceptedAliases,
      lastSeenAt: observedAt,
      salience: Math.max(1, Number((candidate.salience + 1).toFixed(4))),
      evidenceRefs: mergedEvidenceRefs
    });
    acceptedEntityKeys.push(candidate.entityKey);
  }

  for (const pair of extraction.coMentionPairs) {
    const sourceEntityKey = pair[0];
    const targetEntityKey = pair[1];
    if (!entities.has(sourceEntityKey) || !entities.has(targetEntityKey)) {
      continue;
    }
    const edgeKey = buildEdgeKey(sourceEntityKey, targetEntityKey);
    const relationType: RelationTypeV1 = "co_mentioned";
    const status: MemoryStatusV1 = "uncertain";
    const existing = edges.get(edgeKey);
    if (!existing) {
      edges.set(edgeKey, {
        edgeKey,
        sourceEntityKey,
        targetEntityKey,
        relationType,
        status,
        coMentionCount: 1,
        strength: 1,
        firstObservedAt: observedAt,
        lastObservedAt: observedAt,
        evidenceRefs: [evidenceRef]
      });
      continue;
    }

    edges.set(edgeKey, {
      ...existing,
      coMentionCount: existing.coMentionCount + 1,
      strength: Number(
        (existing.strength + computeCoMentionIncrement(existing.lastObservedAt, observedAt)).toFixed(4)
      ),
      lastObservedAt: observedAt,
      evidenceRefs: mergeStringList(existing.evidenceRefs, [evidenceRef], 64)
    });
  }

  const evictedEdgeKeys = enforceEdgeCaps(edges, maxGraphEdgesPerEntity);
  const nextGraph: EntityGraphV1 = {
    schemaVersion: "v1",
    updatedAt: observedAt,
    entities: sortEntityNodes([...entities.values()]),
    edges: sortRelationEdges([...edges.values()]),
    decisionRecords: graph.decisionRecords ?? []
  };

  return {
    graph: nextGraph,
    acceptedEntityKeys: [...new Set(acceptedEntityKeys)].sort((left, right) => left.localeCompare(right)),
    aliasConflicts,
    evictedEdgeKeys
  };
}

/**
 * Migrates relation edge with confirmation to the next deterministic lifecycle state.
 *
 * **Why it exists:**
 * Centralizes relation edge with confirmation state-transition logic to keep evolution deterministic and reviewable.
 *
 * **What it talks to:**
 * - Uses `EntityGraphV1` (import `EntityGraphV1`) from `./types`.
 * - Uses `MemoryStatusV1` (import `MemoryStatusV1`) from `./types`.
 *
 * @param graph - Value for graph.
 * @param input - Structured input object for this operation.
 * @returns Computed `Stage686RelationPromotionResult` result.
 */
export function promoteRelationEdgeWithConfirmation(
  graph: EntityGraphV1,
  input: Stage686RelationPromotionInput
): Stage686RelationPromotionResult {
  assertValidIsoTimestamp(input.observedAt, "observedAt");
  if (!input.explicitUserConfirmation) {
    return {
      graph,
      promoted: false,
      deniedConflictCode: "INSUFFICIENT_EVIDENCE",
      edgeKey: null
    };
  }

  const edgeKey = buildEdgeKey(input.sourceEntityKey, input.targetEntityKey);
  const existingEdge = graph.edges.find((edge) => edge.edgeKey === edgeKey);
  if (!existingEdge) {
    return {
      graph,
      promoted: false,
      deniedConflictCode: "INSUFFICIENT_EVIDENCE",
      edgeKey: null
    };
  }

  const promotedEdges = graph.edges.map((edge) => {
    if (edge.edgeKey !== edgeKey) {
      return edge;
    }
    return {
      ...edge,
      relationType: input.relationType,
      status: "confirmed" as MemoryStatusV1,
      lastObservedAt: input.observedAt,
      evidenceRefs: mergeStringList(edge.evidenceRefs, [input.evidenceRef], 64)
    };
  });

  const promotedGraph: EntityGraphV1 = {
    ...graph,
    updatedAt: input.observedAt,
    edges: sortRelationEdges(promotedEdges)
  };

  return {
    graph: promotedGraph,
    promoted: true,
    deniedConflictCode: null,
    edgeKey
  };
}

/**
 * Implements enforce edge caps behavior used by `stage6_86EntityGraph`.
 *
 * **Why it exists:**
 * Keeps `enforce edge caps` behavior centralized so collaborating call sites stay consistent.
 *
 * **What it talks to:**
 * - Uses `RelationEdgeV1` (import `RelationEdgeV1`) from `./types`.
 *
 * @param edges - Value for edges.
 * @param maxGraphEdgesPerEntity - Numeric bound, counter, or index used by this logic.
 * @returns Ordered collection produced by this step.
 */
function enforceEdgeCaps(
  edges: Map<string, RelationEdgeV1>,
  maxGraphEdgesPerEntity: number
): readonly string[] {
  const cap = Math.max(1, Math.floor(maxGraphEdgesPerEntity));
  const evictedEdgeKeys: string[] = [];

  while (true) {
    const byEntity = new Map<string, RelationEdgeV1[]>();
    for (const edge of edges.values()) {
      const sourceList = byEntity.get(edge.sourceEntityKey) ?? [];
      sourceList.push(edge);
      byEntity.set(edge.sourceEntityKey, sourceList);

      const targetList = byEntity.get(edge.targetEntityKey) ?? [];
      targetList.push(edge);
      byEntity.set(edge.targetEntityKey, targetList);
    }

    const overCapEntity = [...byEntity.entries()]
      .filter((entry) => entry[1].length > cap)
      .map((entry) => entry[0])
      .sort((left, right) => left.localeCompare(right))[0];

    if (!overCapEntity) {
      return evictedEdgeKeys;
    }

    const candidateEdges = (byEntity.get(overCapEntity) ?? []).sort((left, right) => {
      if (left.strength !== right.strength) {
        return left.strength - right.strength;
      }
      if (left.coMentionCount !== right.coMentionCount) {
        return left.coMentionCount - right.coMentionCount;
      }
      if (left.lastObservedAt !== right.lastObservedAt) {
        return left.lastObservedAt.localeCompare(right.lastObservedAt);
      }
      return left.edgeKey.localeCompare(right.edgeKey);
    });

    const edgeToEvict = candidateEdges[0];
    if (!edgeToEvict) {
      return evictedEdgeKeys;
    }
    edges.delete(edgeToEvict.edgeKey);
    evictedEdgeKeys.push(edgeToEvict.edgeKey);
  }
}
