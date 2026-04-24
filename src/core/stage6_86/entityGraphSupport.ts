import {
  EntityGraphV1,
  EntityNodeV1,
  EntityTypeV1,
  RelationEdgeV1
} from "../types";
import { sha256HexFromCanonicalJson } from "../normalizers/canonicalizationRules";
import type {
  Stage686EntityDomainHint,
  Stage686EntityExtractionInput,
  Stage686EntityTypeHint
} from "./entityGraph";

const ENTITY_STOP_WORDS = new Set([
  "The",
  "A",
  "An",
  "And",
  "Any",
  "Attached",
  "Can",
  "Close",
  "Could",
  "Create",
  "Do",
  "Does",
  "Did",
  "Explain",
  "Execute",
  "Good",
  "Hi",
  "Hello",
  "Hey",
  "How",
  "Or",
  "But",
  "If",
  "Keep",
  "Leave",
  "Look",
  "Need",
  "No",
  "Now",
  "Okay",
  "Open",
  "Please",
  "Put",
  "Run",
  "So",
  "Start",
  "Status",
  "Stop",
  "Sure",
  "Tell",
  "Then",
  "Thanks",
  "That's",
  "When",
  "Who",
  "What",
  "Whats",
  "What's",
  "Where",
  "Why",
  "Yeah",
  "Yes",
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
const ORG_HINT_TOKENS = new Set([
  "inc",
  "llc",
  "ltd",
  "corp",
  "company",
  "studio",
  "labs",
  "systems",
  "group",
  "school",
  "university"
]);
const EVENT_HINT_TOKENS = new Set([
  "meeting",
  "review",
  "launch",
  "summit",
  "conference",
  "checkpoint",
  "deadline"
]);
const MAX_ENTITY_MAX_ALIASES = 64;
const CO_MENTION_RECENCY_HALFLIFE_DAYS = 30;
const ENTITY_DOMAIN_HINTS = ["profile", "relationship", "workflow", "system_policy"] as const;
const PROFILE_SYSTEM_POLICY: Extract<EntityNodeV1["domainHint"], "profile" | "relationship" | "workflow">[] = [
  "profile",
  "relationship",
  "workflow"
];
const MAX_ENTITY_CANDIDATE_SPAN_TOKENS = 4;

/**
 * Evaluates whether upper ascii letter.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function isUpperAsciiLetter(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  const code = value.charCodeAt(0);
  return code >= 65 && code <= 90;
}

/**
 * Evaluates whether entity token character.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param char - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function isEntityTokenCharacter(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    char === "'" ||
    char === "." ||
    char === "_" ||
    char === "-"
  );
}

/**
 * Evaluates whether whitespace character.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param char - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function isWhitespaceCharacter(char: string): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}

/**
 * Trims entity boundary punctuation.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param token - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function trimEntityBoundaryPunctuation(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && !isEntityTokenCharacter(token[start]!)) {
    start += 1;
  }
  while (end > start && !isEntityTokenCharacter(token[end - 1]!)) {
    end -= 1;
  }
  return token.slice(start, end);
}

/**
 * Evaluates whether entity token candidate.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param rawToken - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function isEntityTokenCandidate(rawToken: string): boolean {
  if (!rawToken || rawToken.includes("\\") || rawToken.includes("/") || rawToken.includes(":")) {
    return false;
  }
  const cleaned = trimEntityBoundaryPunctuation(rawToken);
  if (!cleaned || !isUpperAsciiLetter(cleaned)) {
    return false;
  }
  for (const char of cleaned) {
    if (!isEntityTokenCharacter(char)) {
      return false;
    }
  }
  return true;
}

/**
 * Endss sentence.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param rawToken - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function endsSentence(rawToken: string): boolean {
  for (let index = rawToken.length - 1; index >= 0; index -= 1) {
    const char = rawToken[index]!;
    if (char === "." || char === "!" || char === "?") {
      return true;
    }
    if (isWhitespaceCharacter(char)) {
      continue;
    }
    return false;
  }
  return false;
}

/**
 * Collects entity candidate spans.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param text - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function collectEntityCandidateSpans(text: string): readonly string[] {
  const spans: string[] = [];
  const currentSpan: string[] = [];
  const flush = (): void => {
    if (currentSpan.length === 0) {
      return;
    }
    spans.push(currentSpan.join(" "));
    currentSpan.length = 0;
  };

  for (const rawToken of text.split(/\s+/).filter((token) => token.length > 0)) {
    const cleaned = trimEntityBoundaryPunctuation(rawToken);
    if (!isEntityTokenCandidate(rawToken) || !cleaned) {
      flush();
      continue;
    }
    if (currentSpan.length === 0 && ENTITY_STOP_WORDS.has(cleaned)) {
      continue;
    }
    currentSpan.push(cleaned);
    if (currentSpan.length >= MAX_ENTITY_CANDIDATE_SPAN_TOKENS || endsSentence(rawToken)) {
      flush();
    }
  }
  flush();
  return spans;
}

/**
 * Gets entity lookup terms.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `EntityNodeV1` (import `EntityNodeV1`) from `../types`.
 * @param entity - Input consumed by this helper.
 * @returns Result produced by this helper.
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
 * Queries entity graph nodes by canonical or alias.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `EntityGraphV1` (import `EntityGraphV1`) from `../types`.
 * - Uses `EntityNodeV1` (import `EntityNodeV1`) from `../types`.
 * @param graph - Input consumed by this helper.
 * @param candidateName - Input consumed by this helper.
 * @returns Result produced by this helper.
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
 * Asserts valid iso timestamp.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @param fieldName - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function assertValidIsoTimestamp(value: string, fieldName: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`Invalid ISO timestamp for ${fieldName}: ${value}`);
  }
}

/**
 * Normalizes whitespace.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Normalizes alias key.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function normalizeAliasKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalizes entity domain hint.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `EntityNodeV1` (import `EntityNodeV1`) from `../types`.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function normalizeEntityDomainHint(
  value: unknown
): EntityNodeV1["domainHint"] {
  return typeof value === "string" &&
    (ENTITY_DOMAIN_HINTS as readonly string[]).includes(value)
    ? (value as EntityNodeV1["domainHint"])
    : null;
}

/**
 * Merges entity domain hint.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `EntityNodeV1` (import `EntityNodeV1`) from `../types`.
 * - Uses `Stage686EntityExtractionInput` (import `Stage686EntityExtractionInput`) from `./entityGraph`.
 * @param existing - Input consumed by this helper.
 * @param incoming - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function mergeEntityDomainHint(
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
 * Converts to canonical name.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param raw - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function toCanonicalName(raw: string): string {
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
 * Derives entity type.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `EntityTypeV1` (import `EntityTypeV1`) from `../types`.
 * @param raw - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function deriveEntityType(raw: string): EntityTypeV1 {
  const normalizedTokens = normalizeAliasKey(raw)
    .split(" ")
    .filter((token) => token.length > 0);
  if (normalizedTokens.some((token) => ORG_HINT_TOKENS.has(token))) {
    return "org";
  }
  if (normalizedTokens.some((token) => EVENT_HINT_TOKENS.has(token))) {
    return "event";
  }
  return raw.split(" ").length >= 2 ? "person" : "thing";
}

/**
 * Normalizes entity candidate.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param raw - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function normalizeEntityCandidate(raw: string): string {
  const normalized = normalizeWhitespace(raw);
  if (!normalized || /[.!?]\s+[A-Z]/.test(normalized)) {
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
 * Evaluates whether low signal canonical entity label.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param canonicalName - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function isLowSignalCanonicalEntityLabel(canonicalName: string): boolean {
  const normalizedCandidate = normalizeEntityCandidate(canonicalName);
  const rawTokens = tokenizeCanonicalLabel(canonicalName);
  const normalizedTokens = tokenizeCanonicalLabel(normalizedCandidate);
  if (normalizedTokens.length === 0) {
    return true;
  }
  if (rawTokens.length > normalizedTokens.length && normalizedTokens.length <= 1) {
    return true;
  }
  return /[.!?]/.test(canonicalName) && normalizedTokens.length <= 2;
}

/**
 * Builds entity type hint map.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `EntityTypeV1` (import `EntityTypeV1`) from `../types`.
 * - Uses `Stage686EntityTypeHint` (import `Stage686EntityTypeHint`) from `./entityGraph`.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function buildEntityTypeHintMap(
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
    if (!["person", "place", "org", "event", "thing", "concept"].includes(String(hint.entityType ?? ""))) {
      continue;
    }
    if (!mapped.has(normalizedKey)) {
      mapped.set(normalizedKey, hint.entityType);
    }
  }
  return mapped;
}

/**
 * Builds entity domain hint map.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `EntityNodeV1` (import `EntityNodeV1`) from `../types`.
 * - Uses `Stage686EntityDomainHint` (import `Stage686EntityDomainHint`) from `./entityGraph`.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function buildEntityDomainHintMap(
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
    if (!normalizedKey || !domainHint || !PROFILE_SYSTEM_POLICY.includes(domainHint as never)) {
      continue;
    }
    if (!mapped.has(normalizedKey)) {
      mapped.set(
        normalizedKey,
        domainHint as Extract<EntityNodeV1["domainHint"], "profile" | "relationship" | "workflow">
      );
    }
  }
  return mapped;
}

/**
 * Builds entity key.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `sha256HexFromCanonicalJson` (import `sha256HexFromCanonicalJson`) from `../normalizers/canonicalizationRules`.
 * - Uses `EntityTypeV1` (import `EntityTypeV1`) from `../types`.
 * @param canonicalName - Input consumed by this helper.
 * @param entityType - Input consumed by this helper.
 * @param disambiguator - Input consumed by this helper.
 * @returns Result produced by this helper.
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
 * Builds edge key.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `sha256HexFromCanonicalJson` (import `sha256HexFromCanonicalJson`) from `../normalizers/canonicalizationRules`.
 * @param sourceEntityKey - Input consumed by this helper.
 * @param targetEntityKey - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function buildEdgeKey(sourceEntityKey: string, targetEntityKey: string): string {
  const ordered =
    sourceEntityKey.localeCompare(targetEntityKey) <= 0
      ? [sourceEntityKey, targetEntityKey]
      : [targetEntityKey, sourceEntityKey];
  const fingerprint = sha256HexFromCanonicalJson({ ordered });
  return `edge_${fingerprint.slice(0, 20)}`;
}

/**
 * Computes co mention increment.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param lastObservedAt - Input consumed by this helper.
 * @param observedAt - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function computeCoMentionIncrement(lastObservedAt: string, observedAt: string): number {
  assertValidIsoTimestamp(lastObservedAt, "lastObservedAt");
  assertValidIsoTimestamp(observedAt, "observedAt");
  const deltaDays = Math.max(
    0,
    (Date.parse(observedAt) - Date.parse(lastObservedAt)) / (24 * 60 * 60 * 1_000)
  );
  const decayFactor = Math.pow(0.5, deltaDays / CO_MENTION_RECENCY_HALFLIFE_DAYS);
  return Number(Math.max(0.05, decayFactor).toFixed(4));
}

/**
 * Merges string list.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param left - Input consumed by this helper.
 * @param right - Input consumed by this helper.
 * @param limit - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function mergeStringList(
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
    if (!key || merged.has(key)) {
      continue;
    }
    merged.set(key, normalized);
  }

  return [...merged.values()]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, boundedLimit);
}

/**
 * Sorts entity nodes.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `EntityNodeV1` (import `EntityNodeV1`) from `../types`.
 * @param nodes - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function sortEntityNodes(nodes: readonly EntityNodeV1[]): readonly EntityNodeV1[] {
  return [...nodes].sort((left, right) => left.entityKey.localeCompare(right.entityKey));
}

/**
 * Sorts relation edges.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `RelationEdgeV1` (import `RelationEdgeV1`) from `../types`.
 * @param edges - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function sortRelationEdges(edges: readonly RelationEdgeV1[]): readonly RelationEdgeV1[] {
  return [...edges].sort((left, right) => left.edgeKey.localeCompare(right.edgeKey));
}

/**
 * Creates empty entity graph v1.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `EntityGraphV1` (import `EntityGraphV1`) from `../types`.
 * @param updatedAt - Input consumed by this helper.
 * @returns Result produced by this helper.
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
 * Tokenizes canonical label.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function tokenizeCanonicalLabel(value: string): readonly string[] {
  const normalized = normalizeAliasKey(value);
  return normalized ? normalized.split(" ").filter(Boolean) : [];
}
