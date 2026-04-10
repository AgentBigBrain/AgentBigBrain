/**
 * @fileoverview Focus-entity selection helpers for bounded graph-backed temporal queries.
 */

import {
  type ProfileMemoryGraphClaimRecord,
  type ProfileMemoryGraphEventRecord,
  type ProfileMemoryGraphObservationRecord
} from "./profileMemoryGraphContracts";
import { getProfileMemorySelfStableRefId, type ProfileMemoryGraphStableRefGroup } from "./profileMemoryGraphQueries";
import type { ProfileMemoryTemporalQueryCaps, ProfileMemoryTemporalQueryRequest } from "./profileMemoryTemporalQueryContracts";

/**
 * Tokenizes one freeform hint string into deterministic lower-case search terms.
 *
 * **Why it exists:**
 * Temporal retrieval ranks bounded evidence with lexical overlap, so this helper keeps the term
 * normalization rule centralized across group, claim, and event scoring.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Freeform hint or surface text.
 * @returns Deduplicated lower-case comparison terms.
 */
export function tokenizeTemporalTerms(value: string): readonly string[] {
  const lowercaseValue = value.toLowerCase();
  const matches = lowercaseValue.match(/[a-z0-9]+/g) ?? [];
  const initialisms = lowercaseValue.match(/\b(?:[a-z0-9]\.){2,}(?:[a-z0-9]\.?)?/g) ?? [];
  return [...new Set([
    ...matches.filter((entry) => entry.length >= 2),
    ...initialisms
  ])];
}

/**
 * Builds one lexical search surface for a stable-ref group and its attached evidence.
 *
 * **Why it exists:**
 * Focus-entity selection needs a bounded search text that merges group, claim, event, and
 * observation surfaces without exposing that concatenation logic to the retrieval entrypoint.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param group - Stable-ref group under scoring.
 * @param claims - Claims attached to the group.
 * @param events - Events attached to the group.
 * @param observations - Observations attached to the group.
 * @returns Concatenated bounded search text.
 */
export function buildGroupSearchText(
  group: ProfileMemoryGraphStableRefGroup,
  claims: readonly ProfileMemoryGraphClaimRecord[],
  events: readonly ProfileMemoryGraphEventRecord[],
  observations: readonly ProfileMemoryGraphObservationRecord[]
): string {
  return [
    group.stableRefId,
    ...group.entityRefIds,
    ...group.families,
    ...claims.flatMap((claim) => [claim.payload.normalizedKey, claim.payload.normalizedValue ?? ""]),
    ...events.flatMap((event) => [event.payload.title, event.payload.summary]),
    ...observations.flatMap((observation) => [
      observation.payload.normalizedKey ?? "",
      observation.payload.normalizedValue ?? ""
    ])
  ].join(" ");
}

/**
 * Selects the bounded focus-entity group set for one temporal query.
 *
 * **Why it exists:**
 * The retrieval entrypoint should consume a ready-made focus group list instead of carrying the
 * lexical ranking and self-fallback logic inline.
 *
 * **What it talks to:**
 * - Uses `getProfileMemorySelfStableRefId` (import `getProfileMemorySelfStableRefId`) from `./profileMemoryGraphQueries`.
 * - Uses local helpers within this module.
 *
 * @param request - Temporal query request.
 * @param groups - Stable-ref groups available in graph state.
 * @param claimsByStableRefId - Claims indexed by stable-ref id.
 * @param eventsByStableRefId - Events indexed by stable-ref id.
 * @param observationsByStableRefId - Observations indexed by stable-ref id.
 * @param caps - Active retrieval caps.
 * @param degradedNotes - Top-level degraded-note accumulator.
 * @returns Bounded selected focus groups plus their matched hint terms.
 */
export function selectFocusGroups(
  request: ProfileMemoryTemporalQueryRequest,
  groups: readonly ProfileMemoryGraphStableRefGroup[],
  claimsByStableRefId: ReadonlyMap<string, readonly ProfileMemoryGraphClaimRecord[]>,
  eventsByStableRefId: ReadonlyMap<string, readonly ProfileMemoryGraphEventRecord[]>,
  observationsByStableRefId: ReadonlyMap<string, readonly ProfileMemoryGraphObservationRecord[]>,
  caps: ProfileMemoryTemporalQueryCaps,
  degradedNotes: string[]
): readonly { group: ProfileMemoryGraphStableRefGroup; matchedHintTerms: readonly string[] }[] {
  const entityHintTerms = tokenizeTemporalTerms(request.entityHints.join(" "));
  const queryTerms = tokenizeTemporalTerms(request.queryText ?? "");
  const hintTerms = [...new Set([...entityHintTerms, ...queryTerms])];
  if (groups.length === 0) {
    return [];
  }
  if (hintTerms.length === 0) {
    const selfGroup = groups.find((group) => group.stableRefId === getProfileMemorySelfStableRefId());
    return selfGroup ? [{ group: selfGroup, matchedHintTerms: [] }] : groups.slice(0, 1).map((group) => ({
      group,
      matchedHintTerms: []
    }));
  }

  const ranked = groups
    .map((group) => {
      const searchTerms = new Set(
        tokenizeTemporalTerms(
          buildGroupSearchText(
            group,
            claimsByStableRefId.get(group.stableRefId) ?? [],
            eventsByStableRefId.get(group.stableRefId) ?? [],
            observationsByStableRefId.get(group.stableRefId) ?? []
          )
        )
      );
      const matchedHintTerms = hintTerms.filter((term) => searchTerms.has(term));
      return { group, matchedHintTerms, score: matchedHintTerms.length };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.group.stableRefId.localeCompare(right.group.stableRefId);
    });

  if (ranked.length === 0 && entityHintTerms.length === 0) {
    const selfGroup = groups.find((group) => group.stableRefId === getProfileMemorySelfStableRefId());
    return selfGroup ? [{ group: selfGroup, matchedHintTerms: [] }] : groups.slice(0, 1).map((group) => ({
      group,
      matchedHintTerms: []
    }));
  }
  if (ranked.length > caps.maxFocusEntities) {
    degradedNotes.push(`bounded_overflow:${ranked.length - caps.maxFocusEntities} focus entities omitted`);
  }
  return ranked.slice(0, caps.maxFocusEntities).map((entry) => ({
    group: entry.group,
    matchedHintTerms: entry.matchedHintTerms
  }));
}
