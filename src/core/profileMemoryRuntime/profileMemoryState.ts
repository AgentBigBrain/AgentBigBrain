/**
 * @fileoverview Canonical profile-memory state creation and freshness helpers.
 */

import type {
  ProfileFactRecord,
  ProfileFreshnessAssessment,
  ProfileEpisodeRecord,
  ProfileMemoryState
} from "../profileMemory";

export const PROFILE_MEMORY_SCHEMA_VERSION = 2;
export const DEFAULT_PROFILE_STALE_AFTER_DAYS = 90;

/**
 * Creates a fresh in-memory profile state envelope.
 *
 * @returns Empty profile-memory state with current `updatedAt`.
 */
export function createEmptyProfileMemoryState(): ProfileMemoryState {
  return {
    schemaVersion: PROFILE_MEMORY_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    facts: [],
    episodes: [],
    ingestReceipts: []
  };
}

/**
 * Computes freshness/staleness for one profile fact relative to a reference time.
 *
 * @param fact - Fact record to evaluate.
 * @param maxAgeDays - Maximum allowed age before the fact is considered stale.
 * @param nowIso - Reference timestamp for age calculation.
 * @returns Staleness flag plus computed age in whole days.
 */
export function assessProfileFactFreshness(
  fact: ProfileFactRecord,
  maxAgeDays: number,
  nowIso: string = new Date().toISOString()
): ProfileFreshnessAssessment {
  const observed = Date.parse(fact.observedAt);
  const now = Date.parse(nowIso);
  const ageDays = Math.max(0, Math.floor((now - observed) / 86_400_000));
  return {
    stale: ageDays > Math.max(0, maxAgeDays),
    ageDays
  };
}

/**
 * Downgrades stale confirmed facts to uncertain status.
 *
 * @param state - Current profile state.
 * @param maxAgeDays - Staleness threshold in days.
 * @param nowIso - Reference timestamp for freshness checks.
 * @returns Updated state and IDs of facts that were downgraded.
 */
export function markStaleFactsAsUncertain(
  state: ProfileMemoryState,
  maxAgeDays: number,
  nowIso: string = new Date().toISOString()
): { nextState: ProfileMemoryState; updatedFactIds: string[] } {
  const updatedFactIds: string[] = [];
  const nextFacts = state.facts.map((fact): ProfileFactRecord => {
    if (!isActiveFact(fact) || fact.status !== "confirmed") {
      return fact;
    }
    const freshness = assessProfileFactFreshness(fact, maxAgeDays, nowIso);
    if (!freshness.stale) {
      return fact;
    }
    updatedFactIds.push(fact.id);
    return {
      ...fact,
      status: "uncertain",
      confidence: Math.min(fact.confidence, 0.5),
      lastUpdatedAt: nowIso
    };
  });

  if (updatedFactIds.length === 0) {
    return {
      nextState: state,
      updatedFactIds
    };
  }

  return {
    nextState: {
      schemaVersion: PROFILE_MEMORY_SCHEMA_VERSION,
      updatedAt: nowIso,
      facts: nextFacts,
      episodes: state.episodes ?? [],
      ingestReceipts: state.ingestReceipts ?? []
    },
    updatedFactIds
  };
}

/**
 * Returns the canonical episode collection from one profile-memory state envelope.
 *
 * @param state - Profile-memory state under inspection.
 * @returns Episode collection, or an empty array when none exist.
 */
export function getProfileEpisodes(state: ProfileMemoryState): readonly ProfileEpisodeRecord[] {
  return state.episodes ?? [];
}

/**
 * Evaluates whether a profile fact remains active.
 *
 * @param fact - Candidate fact.
 * @returns `true` when the fact is active.
 */
function isActiveFact(fact: ProfileFactRecord): boolean {
  return fact.status !== "superseded" && fact.supersededAt === null;
}
