/**
 * @fileoverview Builds query-aware, non-sensitive planning context selections from profile memory state.
 */

import {
  buildPlanningContextFromProfile,
  ProfileFactRecord,
  ProfileMemoryState
} from "./profileMemory";

const PLANNING_QUERY_STOP_WORDS = new Set([
  "who",
  "what",
  "where",
  "when",
  "why",
  "how",
  "is",
  "are",
  "was",
  "were",
  "do",
  "does",
  "did",
  "my",
  "me",
  "i",
  "we",
  "you",
  "the",
  "a",
  "an",
  "to",
  "at",
  "for",
  "in",
  "on",
  "of",
  "and",
  "about",
  "relation",
  "related",
  "now"
]);

const IDENTITY_ANCHOR_PREFIXES = ["identity.preferred_name", "identity.name", "name"];

/**
 * Evaluates active fact and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the active fact policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `ProfileFactRecord` (import `ProfileFactRecord`) from `./profileMemory`.
 *
 * @param fact - Value for fact.
 * @returns `true` when this check passes.
 */
function isActiveFact(fact: ProfileFactRecord): boolean {
  return fact.status !== "superseded" && fact.supersededAt === null;
}

/**
 * Derives planning query tokens from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for planning query tokens in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param queryInput - Structured input object for this operation.
 * @returns Ordered collection produced by this step.
 */
function extractPlanningQueryTokens(queryInput: string): string[] {
  const normalized = queryInput
    .toLowerCase()
    .replace(/[^a-z0-9\s_.-]+/g, " ")
    .replace(/[\s_.-]+/g, " ")
    .trim();
  if (!normalized) {
    return [];
  }

  const tokens = normalized
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter((token) => !PLANNING_QUERY_STOP_WORDS.has(token));

  return [...new Set(tokens)].slice(0, 12);
}

/**
 * Evaluates identity anchor fact and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the identity anchor fact policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `ProfileFactRecord` (import `ProfileFactRecord`) from `./profileMemory`.
 *
 * @param fact - Value for fact.
 * @returns `true` when this check passes.
 */
function isIdentityAnchorFact(fact: ProfileFactRecord): boolean {
  const normalizedKey = fact.key.toLowerCase();
  return IDENTITY_ANCHOR_PREFIXES.some(
    (prefix) =>
      normalizedKey === prefix ||
      normalizedKey.startsWith(`${prefix}.`)
  );
}

/**
 * Implements score fact for planning query behavior used by `profileMemoryPlanningContext`.
 *
 * **Why it exists:**
 * Keeps `score fact for planning query` behavior centralized so collaborating call sites stay consistent.
 *
 * **What it talks to:**
 * - Uses `ProfileFactRecord` (import `ProfileFactRecord`) from `./profileMemory`.
 *
 * @param fact - Value for fact.
 * @param queryTokens - Token value used for lexical parsing or matching.
 * @returns Computed numeric value.
 */
function scoreFactForPlanningQuery(
  fact: ProfileFactRecord,
  queryTokens: string[]
): number {
  if (queryTokens.length === 0) {
    return 0;
  }

  const normalizedKey = fact.key.toLowerCase();
  const normalizedValue = fact.value.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (normalizedKey.includes(`contact.${token}.`)) {
      score += 12;
    }
    if (normalizedKey.includes(token)) {
      score += 4;
    }
    if (normalizedValue.includes(token)) {
      score += 6;
    }
  }

  if (score > 0 && normalizedKey.startsWith("contact.")) {
    score += 2;
  }

  // Prefer structured contact attributes over free-form context snippets under tight budgets.
  if (
    score > 0 &&
    normalizedKey.startsWith("contact.") &&
    (
      normalizedKey.endsWith(".name") ||
      normalizedKey.endsWith(".relationship") ||
      normalizedKey.endsWith(".work_association") ||
      normalizedKey.endsWith(".school_association")
    )
  ) {
    score += 5;
  }

  if (score > 0 && normalizedKey.includes(".context.")) {
    score -= 2;
  }

  return score;
}

/**
 * Builds query aware planning context for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of query aware planning context consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `buildPlanningContextFromProfile` (import `buildPlanningContextFromProfile`) from `./profileMemory`.
 * - Uses `ProfileFactRecord` (import `ProfileFactRecord`) from `./profileMemory`.
 * - Uses `ProfileMemoryState` (import `ProfileMemoryState`) from `./profileMemory`.
 *
 * @param state - Value for state.
 * @param maxFacts - Numeric bound, counter, or index used by this logic.
 * @param queryInput - Structured input object for this operation.
 * @returns Resulting string value.
 */
export function buildQueryAwarePlanningContext(
  state: ProfileMemoryState,
  maxFacts: number,
  queryInput: string
): string {
  const safeMaxFacts = Math.max(0, maxFacts);
  if (safeMaxFacts === 0) {
    return "";
  }

  const queryTokens = extractPlanningQueryTokens(queryInput);
  if (queryTokens.length === 0) {
    return buildPlanningContextFromProfile(state, safeMaxFacts);
  }

  const activeNonSensitiveFacts = state.facts
    .filter((fact) => isActiveFact(fact) && !fact.sensitive)
    .sort((left, right) => Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt));

  const scoredFacts = activeNonSensitiveFacts
    .map((fact) => ({
      fact,
      score: scoreFactForPlanningQuery(fact, queryTokens)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return Date.parse(right.fact.lastUpdatedAt) - Date.parse(left.fact.lastUpdatedAt);
    })
    .map((entry) => entry.fact);

  if (scoredFacts.length === 0) {
    return buildPlanningContextFromProfile(state, safeMaxFacts);
  }

  const selected: ProfileFactRecord[] = [];
  const selectedIds = new Set<string>();
  /**
   * Adds a fact once while preserving insertion order for final context rendering.
   *
   * **Why it exists:**
   * Selection happens in multiple passes (identity anchors, scored facts, fallbacks). This helper
   * centralizes duplicate suppression so each pass can stay simple.
   *
   * **What it talks to:**
   * - Uses local `selectedIds` and `selected` accumulators.
   *
   * @param fact - Fact candidate considered for context output.
   */
  const addFact = (fact: ProfileFactRecord): void => {
    if (selectedIds.has(fact.id)) {
      return;
    }
    selectedIds.add(fact.id);
    selected.push(fact);
  };

  for (const identityFact of activeNonSensitiveFacts.filter((fact) =>
    isIdentityAnchorFact(fact)
  )) {
    addFact(identityFact);
    if (selected.length >= safeMaxFacts) {
      break;
    }
  }

  for (const fact of scoredFacts) {
    addFact(fact);
    if (selected.length >= safeMaxFacts) {
      break;
    }
  }

  if (selected.length < safeMaxFacts) {
    for (const fact of activeNonSensitiveFacts) {
      addFact(fact);
      if (selected.length >= safeMaxFacts) {
        break;
      }
    }
  }

  return buildPlanningContextFromProfile(
    {
      ...state,
      facts: selected
    },
    safeMaxFacts
  );
}
