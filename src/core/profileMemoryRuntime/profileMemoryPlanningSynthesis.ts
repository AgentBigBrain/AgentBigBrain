/**
 * @fileoverview Planner-facing canonical temporal synthesis helpers for profile memory.
 */

import { extractPlanningQueryTerms } from "../languageRuntime/queryIntentTerms";
import type { ProfileMemoryState } from "../profileMemory";
import type { TemporalMemorySynthesis } from "./profileMemoryTemporalQueryContracts";
import { queryProfileFactsForContinuity } from "./profileMemoryQueries";

/**
 * Builds planner-facing canonical temporal synthesis directly from the graph-backed query layer.
 *
 * **Why it exists:**
 * Planner brokerage should consume the same canonical temporal synthesis owner as continuity and
 * review paths instead of rebuilding split-view context from compatibility facts and episodes.
 *
 * @param state - Loaded profile-memory state.
 * @param request - Planner query text plus optional observed-time boundary.
 * @returns Canonical temporal synthesis for planner injection, or `null` when nothing relevant is
 * available.
 */
export function queryProfileTemporalPlanningSynthesis(
  state: ProfileMemoryState,
  request: {
    queryInput?: string;
    maxFacts?: number;
    asOfObservedTime?: string;
  } = {}
): TemporalMemorySynthesis | null {
  const queryInput = request.queryInput?.trim() ?? "";
  if (!queryInput) {
    return null;
  }
  const entityHints = [...extractPlanningQueryTerms(queryInput)];
  return queryProfileFactsForContinuity(state, {
    entityHints: entityHints.length > 0 ? entityHints : [queryInput],
    semanticMode: "relationship_inventory",
    relevanceScope: "global_profile",
    asOfObservedTime: request.asOfObservedTime,
    maxFacts: request.maxFacts ?? 3
  }).temporalSynthesis;
}
