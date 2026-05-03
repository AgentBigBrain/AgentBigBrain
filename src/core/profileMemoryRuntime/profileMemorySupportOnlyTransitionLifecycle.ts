/**
 * @fileoverview Bounded support-only transition repair for compatibility current winners.
 */

import type { ProfileFactRecord, ProfileFactUpsertInput, ProfileMemoryState } from "../profileMemory";
import { createEmptyProfileMemoryGraphState } from "./profileMemoryGraphState";
import {
  canonicalizeProfileKey,
  normalizeProfileValue
} from "./profileMemoryNormalization";
import {
  getProfileMemoryFamilyRegistryEntry
} from "./profileMemoryFamilyRegistry";
import { inferGovernanceFamilyForNormalizedKey } from "./profileMemoryGovernanceFamilyInference";

const WORK_LINKAGE_TRANSITION_SOURCES = new Set([
  "user_input_pattern.work_with_contact_severed",
  "user_input_pattern.work_with_contact_historical",
  "user_input_pattern.work_association_historical",
  "conversation.relationship_interpretation_historical",
  "conversation.relationship_interpretation_severed"
]);

interface SupportOnlyTransitionTarget {
  key: string;
  matchAnyValue: boolean;
  normalizedValue: string | null;
}

/**
 * Closes stale active current winners when a support-only transition candidate proves the same
 * bounded lane is now historical or severed.
 *
 * @param state - Current profile state snapshot.
 * @param candidates - Governed support-only candidates from the current ingest batch.
 * @returns Updated state plus the number of newly superseded current facts.
 */
export function applySupportOnlyTransitionFactCandidates(
  state: ProfileMemoryState,
  candidates: readonly ProfileFactUpsertInput[]
): {
  nextState: ProfileMemoryState;
  supersededFacts: number;
} {
  const targets = buildSupportOnlyTransitionTargets(candidates);
  if (targets.length === 0) {
    return {
      nextState: state,
      supersededFacts: 0
    };
  }

  const nowIso = new Date().toISOString();
  let supersededFacts = 0;
  const nextFacts = state.facts.map((fact) => {
    if (!isSupportOnlyTransitionCandidateTarget(fact, targets)) {
      return fact;
    }
    supersededFacts += 1;
    return {
      ...fact,
      status: "superseded",
      supersededAt: nowIso,
      lastUpdatedAt: nowIso
    } satisfies ProfileFactRecord;
  });

  if (supersededFacts === 0) {
    return {
      nextState: state,
      supersededFacts: 0
    };
  }

  return {
    nextState: {
      ...state,
      updatedAt: nowIso,
      facts: nextFacts,
      graph: state.graph ?? createEmptyProfileMemoryGraphState(nowIso)
    },
    supersededFacts
  };
}

/**
 * Lists the normalized current-lane keys touched by support-only historical or severed
 * transitions.
 *
 * @param candidates - Governed support-only candidates from the current ingest batch.
 * @returns Deterministic current-lane keys whose winners must be reconsidered.
 */
export function listSupportOnlyTransitionKeys(
  candidates: readonly ProfileFactUpsertInput[]
): readonly string[] {
  return buildSupportOnlyTransitionTargets(candidates).map((target) => target.key);
}

/**
 * Builds deterministic current-lane transition targets from support-only historical or severed
 * candidates.
 *
 * @param candidates - Governed support-only candidates from the current ingest batch.
 * @returns Current-lane targets that must fail closed.
 */
function buildSupportOnlyTransitionTargets(
  candidates: readonly ProfileFactUpsertInput[]
): SupportOnlyTransitionTarget[] {
  const serializedTargets = new Set<string>();
  const targets: SupportOnlyTransitionTarget[] = [];

  for (const candidate of candidates) {
    const normalizedKey = canonicalizeProfileKey(candidate.key);
    const normalizedValue = normalizeProfileValue(candidate.value);
    const family = inferGovernanceFamilyForNormalizedKey(normalizedKey, normalizedValue);
    const familyEntry = getProfileMemoryFamilyRegistryEntry(family);
    if (familyEntry.endStatePolicy !== "support_only_transition") {
      continue;
    }

    const normalizedSource = candidate.source.trim().toLowerCase();
    if (WORK_LINKAGE_TRANSITION_SOURCES.has(normalizedSource)) {
      const workLinkageTargets = buildWorkLinkageTransitionTargets(normalizedKey);
      for (const target of workLinkageTargets) {
        appendSupportOnlyTransitionTarget(targets, serializedTargets, target);
      }
      continue;
    }

    appendSupportOnlyTransitionTarget(targets, serializedTargets, {
      key: normalizedKey,
      matchAnyValue: false,
      normalizedValue
    });
  }

  return targets;
}

/**
 * Expands one work-linkage support-only candidate into the bounded current winners that must end.
 *
 * @param normalizedKey - Canonical candidate key.
 * @returns Current-lane targets for that contact's work-linkage bundle.
 */
function buildWorkLinkageTransitionTargets(
  normalizedKey: string
): readonly SupportOnlyTransitionTarget[] {
  const match = normalizedKey.match(/^contact\.([^.]+)\.(relationship|work_association)$/);
  if (!match) {
    return [{
      key: normalizedKey,
      matchAnyValue: false,
      normalizedValue: null
    }];
  }

  const contactPrefix = `contact.${match[1]}`;
  return [
    {
      key: `${contactPrefix}.relationship`,
      matchAnyValue: false,
      normalizedValue: "work_peer"
    },
    {
      key: `${contactPrefix}.work_association`,
      matchAnyValue: true,
      normalizedValue: null
    }
  ];
}

/**
 * Adds one deterministic transition target only once.
 *
 * @param targets - Ordered target collection under construction.
 * @param serializedTargets - Deduplication key set for the same collection.
 * @param target - Candidate target to append.
 */
function appendSupportOnlyTransitionTarget(
  targets: SupportOnlyTransitionTarget[],
  serializedTargets: Set<string>,
  target: SupportOnlyTransitionTarget
): void {
  const dedupeKey = `${target.key}|${target.matchAnyValue ? "*" : target.normalizedValue ?? ""}`;
  if (serializedTargets.has(dedupeKey)) {
    return;
  }
  serializedTargets.add(dedupeKey);
  targets.push(target);
}

/**
 * Checks whether one active current fact should close behind a support-only transition target.
 *
 * @param fact - Existing compatibility fact.
 * @param targets - Deterministic current-lane transition targets.
 * @returns `true` when the fact should become superseded.
 */
function isSupportOnlyTransitionCandidateTarget(
  fact: ProfileFactRecord,
  targets: readonly SupportOnlyTransitionTarget[]
): boolean {
  if (fact.status === "superseded" || fact.supersededAt !== null) {
    return false;
  }

  const normalizedKey = canonicalizeProfileKey(fact.key);
  const normalizedValue = normalizeProfileValue(fact.value);
  return targets.some((target) =>
    target.key === normalizedKey &&
    (target.matchAnyValue || target.normalizedValue === normalizedValue)
  );
}
