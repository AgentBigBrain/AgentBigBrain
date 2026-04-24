/**
 * @fileoverview Query-aware, non-sensitive planning-context selection for profile memory.
 */

import {
  type ProfileFactRecord,
  type ProfileMemoryState
} from "../profileMemory";
import { extractPlanningQueryTerms } from "../languageRuntime/queryIntentTerms";
import { isCompatibilityVisibleFactLike } from "./profileMemoryCompatibilityVisibility";
import { getProfileMemoryFamilyRegistryEntry } from "./profileMemoryFamilyRegistry";
import {
  isStoredProfileFactEffectivelySensitive
} from "./profileMemoryFactSensitivity";
import { inferGovernanceFamilyForNormalizedKey } from "./profileMemoryGovernanceFamilyInference";
import { planningContextPriority } from "./profileMemoryNormalization";
import { readAuthoritativeProfileCompatibilityFacts } from "./profileMemoryFactQuerySupport";

const IDENTITY_ANCHOR_PREFIXES = ["identity.preferred_name", "identity.name", "name"];

/**
 * Renders one bounded ordered fact collection into planner-facing context lines.
 *
 * **Why it exists:**
 * Planner-context rendering now needs to support both full authoritative compatibility state and
 * already-selected bounded fact subsets without accidentally re-reading the whole retained fact
 * array as a second truth owner.
 *
 * **What it talks to:**
 * - Uses local planner-context formatting only.
 *
 * @param facts - Already selected bounded fact records.
 * @param maxFacts - Maximum number of facts to include.
 * @returns Multi-line bullet block or empty string when no facts remain.
 */
function renderPlanningContextFromFacts(
  facts: readonly ProfileFactRecord[],
  maxFacts: number
): string {
  const boundedFacts = facts.slice(0, Math.max(0, maxFacts));
  if (boundedFacts.length === 0) {
    return "";
  }

  return boundedFacts
    .map(
      (fact) =>
        `- ${fact.key}: ${fact.value} (status=${fact.status}, observedAt=${fact.observedAt})`
    )
    .join("\n");
}

/**
 * Renders a bounded, non-sensitive profile context block for planner prompts.
 *
 * @param state - Current normalized profile state.
 * @param maxFacts - Maximum number of facts to include.
 * @returns Multi-line bullet block or empty string when no eligible facts exist.
 */
export function buildPlanningContextFromProfile(
  state: ProfileMemoryState,
  maxFacts: number
): string {
  const activeFacts = readAuthoritativeProfileCompatibilityFacts(state)
    .filter(
      (fact) =>
        !isProfileFactEffectivelySensitive(fact) &&
        isCompatibilityVisibleFactLike(fact)
    )
    .sort((left, right) => {
      const leftPriority = planningContextPriority(left.key);
      const rightPriority = planningContextPriority(right.key);
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }
      return Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt);
    });

  return renderPlanningContextFromFacts(activeFacts, maxFacts);
}

/**
 * Builds query-aware planner context from normalized profile-memory state.
 *
 * @param state - Current normalized profile-memory state.
 * @param maxFacts - Maximum number of facts to include.
 * @param queryInput - Current query text used for relevance ranking.
 * @returns Rendered planner context string.
 */
export function buildQueryAwarePlanningContext(
  state: ProfileMemoryState,
  maxFacts: number,
  queryInput: string
): string {
  const selectedFacts = selectProfileFactsForQuery(state, maxFacts, queryInput);
  return renderPlanningContextFromFacts(selectedFacts, maxFacts);
}

/**
 * Selects bounded active non-sensitive facts for one query-aware retrieval surface.
 *
 * @param state - Current normalized profile-memory state.
 * @param maxFacts - Maximum number of facts to include.
 * @param queryInput - Current query text used for relevance ranking.
 * @returns Deterministically selected active non-sensitive facts.
 */
export function selectProfileFactsForQuery(
  state: ProfileMemoryState,
  maxFacts: number,
  queryInput: string,
  options: {
    includeSensitive?: boolean;
  } = {}
): readonly ProfileFactRecord[] {
  const safeMaxFacts = Math.max(0, maxFacts);
  const includeSensitive = options.includeSensitive === true;
  if (safeMaxFacts === 0) {
    return [];
  }

  const queryTokens = extractPlanningQueryTokens(queryInput);
  if (queryTokens.length === 0) {
    return selectFactsWithinInventoryPolicy(
      readAuthoritativeProfileCompatibilityFacts(state)
        .filter(
          (fact) =>
            (includeSensitive || !isProfileFactEffectivelySensitive(fact)) &&
            isCompatibilityVisibleFactLike(fact)
        )
        .sort((left, right) => {
          const leftPriority = planningContextPriority(left.key);
          const rightPriority = planningContextPriority(right.key);
          if (leftPriority !== rightPriority) {
            return leftPriority - rightPriority;
          }
          return Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt);
        }),
      safeMaxFacts
    );
  }

  const activeNonSensitiveFacts = readAuthoritativeProfileCompatibilityFacts(state)
    .filter(
      (fact) =>
        (includeSensitive || !isProfileFactEffectivelySensitive(fact)) &&
        isCompatibilityVisibleFactLike(fact)
    )
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
    return selectFactsWithinInventoryPolicy(
      readAuthoritativeProfileCompatibilityFacts(state)
        .filter(
          (fact) =>
            (includeSensitive || !isProfileFactEffectivelySensitive(fact)) &&
            isCompatibilityVisibleFactLike(fact)
        )
        .sort((left, right) => {
          const leftPriority = planningContextPriority(left.key);
          const rightPriority = planningContextPriority(right.key);
          if (leftPriority !== rightPriority) {
            return leftPriority - rightPriority;
          }
          return Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt);
        }),
      safeMaxFacts
    );
  }

  const selected: ProfileFactRecord[] = [];
  const selectedIds = new Set<string>();
  const inventoryCounts = new Map<string, number>();
  const addFact = (fact: ProfileFactRecord): void => {
    if (selectedIds.has(fact.id)) {
      return;
    }
    if (!canSelectFactUnderInventoryPolicy(fact, inventoryCounts)) {
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

  return selected;
}

/**
 * Applies registry-owned inventory policy to one ordered fact list.
 *
 * @param facts - Ordered facts under evaluation.
 * @param maxFacts - Maximum number of facts to keep.
 * @returns Facts that remain visible after inventory-policy caps are applied.
 */
function selectFactsWithinInventoryPolicy(
  facts: readonly ProfileFactRecord[],
  maxFacts: number
): readonly ProfileFactRecord[] {
  const selected: ProfileFactRecord[] = [];
  const inventoryCounts = new Map<string, number>();

  for (const fact of facts) {
    if (selected.length >= maxFacts) {
      break;
    }
    if (!canSelectFactUnderInventoryPolicy(fact, inventoryCounts)) {
      continue;
    }
    selected.push(fact);
  }

  return selected;
}

/**
 * Evaluates whether one fact still fits inside the registry-owned inventory cap for its family.
 *
 * @param fact - Fact under evaluation.
 * @param inventoryCounts - Mutable scope counter map for the current selection pass.
 * @returns `true` when the fact may be selected.
 */
function canSelectFactUnderInventoryPolicy(
  fact: ProfileFactRecord,
  inventoryCounts: Map<string, number>
): boolean {
  const { scopeKey, maxVisibleEntries } = getInventoryScopeLimit(fact);
  const currentCount = inventoryCounts.get(scopeKey) ?? 0;
  if (currentCount >= maxVisibleEntries) {
    return false;
  }
  inventoryCounts.set(scopeKey, currentCount + 1);
  return true;
}

/**
 * Resolves the registry-owned inventory scope and cap for one fact.
 *
 * @param fact - Fact under evaluation.
 * @returns Scope key plus maximum visible entry count for that scope.
 */
function getInventoryScopeLimit(fact: ProfileFactRecord): {
  scopeKey: string;
  maxVisibleEntries: number;
} {
  const normalizedKey = fact.key.trim().toLowerCase();
  const family = inferGovernanceFamilyForNormalizedKey(normalizedKey, fact.value);
  const familyEntry = getProfileMemoryFamilyRegistryEntry(family);

  if (familyEntry.inventoryPolicy === "bounded_multi_value") {
    const contextScopeMatch = normalizedKey.match(/^(contact\.[^.]+\.context)\.[^.]+$/);
    return {
      scopeKey: contextScopeMatch?.[1] ?? normalizedKey,
      maxVisibleEntries: 2
    };
  }

  if (familyEntry.inventoryPolicy === "auxiliary_hidden") {
    return {
      scopeKey: normalizedKey,
      maxVisibleEntries: 0
    };
  }

  return {
    scopeKey: normalizedKey,
    maxVisibleEntries: 1
  };
}

/**
 * Evaluates whether a stored fact should be treated as sensitive after the code-owned family floor
 * is enforced.
 *
 * @param fact - Stored fact under evaluation.
 * @returns `true` when the fact is effectively sensitive on bounded planning/query surfaces.
 */
function isProfileFactEffectivelySensitive(fact: ProfileFactRecord): boolean {
  return isStoredProfileFactEffectivelySensitive(fact);
}

/**
 * Extracts normalized planning-query tokens from free-form input.
 *
 * @param queryInput - Query or goal text under analysis.
 * @returns Ordered unique query tokens used for scoring.
 */
function extractPlanningQueryTokens(queryInput: string): string[] {
  return [...extractPlanningQueryTerms(queryInput)];
}

/**
 * Detects identity-anchor facts that should be preserved under tight budgets.
 *
 * @param fact - Profile fact under evaluation.
 * @returns `true` when the fact is an identity anchor.
 */
function isIdentityAnchorFact(fact: ProfileFactRecord): boolean {
  const normalizedKey = fact.key.toLowerCase();
  return IDENTITY_ANCHOR_PREFIXES.some(
    (prefix) => normalizedKey === prefix || normalizedKey.startsWith(`${prefix}.`)
  );
}

/**
 * Scores a fact for relevance against query tokens.
 *
 * @param fact - Profile fact being ranked.
 * @param queryTokens - Normalized query tokens used for ranking.
 * @returns Deterministic relevance score.
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

  if (
    score > 0 &&
    normalizedKey.startsWith("contact.") &&
    (
      normalizedKey.endsWith(".name") ||
      normalizedKey.endsWith(".relationship") ||
      normalizedKey.endsWith(".work_association") ||
      normalizedKey.endsWith(".organization_association") ||
      normalizedKey.endsWith(".location_association") ||
      normalizedKey.endsWith(".primary_location_association") ||
      normalizedKey.endsWith(".secondary_location_association") ||
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
