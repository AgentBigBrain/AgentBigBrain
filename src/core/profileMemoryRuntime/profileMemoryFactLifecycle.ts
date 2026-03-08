/**
 * @fileoverview Canonical profile-memory fact upsert lifecycle helpers.
 */

import { makeId } from "../ids";
import type {
  ProfileFactRecord,
  ProfileFactStatus,
  ProfileFactUpsertInput,
  ProfileMemoryState,
  ProfileUpsertResult
} from "../profileMemory";
import {
  canonicalizeProfileKey,
  normalizeProfileKey,
  normalizeProfileValue
} from "./profileMemoryNormalization";
import {
  PROFILE_MEMORY_SCHEMA_VERSION
} from "./profileMemoryState";
import { safeIsoOrNow } from "./profileMemoryStateNormalization";

/**
 * Upserts one temporal profile fact and supersedes conflicting active facts on the same key.
 *
 * @param state - Current profile state snapshot.
 * @param input - Validated profile fact candidate to apply.
 * @returns Next-state payload, chosen/upserted fact, and superseded fact IDs.
 */
export function upsertTemporalProfileFact(
  state: ProfileMemoryState,
  input: ProfileFactUpsertInput
): ProfileUpsertResult {
  assertUpsertInput(input);
  const key = canonicalizeProfileKey(input.key);
  const value = normalizeProfileValue(input.value);
  const confidence = normalizeConfidence(input.confidence);
  const observedAt = safeIsoOrNow(input.observedAt);
  const nowIso = new Date().toISOString();
  const status = toProfileFactStatus(confidence);

  const nextFacts: ProfileFactRecord[] = [];
  const supersededFactIds: string[] = [];
  let refreshedFact: ProfileFactRecord | null = null;

  for (const fact of state.facts) {
    if (!isActiveFact(fact) || fact.key !== key) {
      nextFacts.push(fact);
      continue;
    }

    if (keyAndValueMatch(fact, key, value)) {
      refreshedFact = {
        ...fact,
        status:
          fact.status === "confirmed" && status === "uncertain"
            ? "confirmed"
            : status,
        confidence: Math.max(fact.confidence, confidence),
        confirmedAt:
          status === "confirmed"
            ? fact.confirmedAt ?? nowIso
            : fact.confirmedAt,
        lastUpdatedAt: nowIso,
        mutationAudit: input.mutationAudit ?? fact.mutationAudit
      };
      nextFacts.push(refreshedFact);
      continue;
    }

    supersededFactIds.push(fact.id);
    nextFacts.push({
      ...fact,
      status: "superseded",
      supersededAt: nowIso,
      lastUpdatedAt: nowIso
    });
  }

  const upsertedFact =
    refreshedFact ?? {
      id: makeId("profile_fact"),
      key,
      value,
      sensitive: input.sensitive,
      status,
      confidence,
      sourceTaskId: input.sourceTaskId,
      source: input.source,
      observedAt,
      confirmedAt: status === "confirmed" ? nowIso : null,
      supersededAt: null,
      lastUpdatedAt: nowIso,
      mutationAudit: input.mutationAudit ?? undefined
    };

  if (!refreshedFact) {
    nextFacts.push(upsertedFact);
  }

  return {
    nextState: {
      schemaVersion: PROFILE_MEMORY_SCHEMA_VERSION,
      updatedAt: nowIso,
      facts: nextFacts,
      episodes: state.episodes ?? []
    },
    upsertedFact,
    supersededFactIds
  };
}

/**
 * Normalizes confidence into a stable profile-memory confidence value.
 *
 * @param value - Candidate confidence.
 * @returns Normalized confidence in the closed interval `[0, 1]`.
 */
function normalizeConfidence(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0.9;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

/**
 * Converts confidence into an initial profile-fact status.
 *
 * @param confidence - Normalized confidence.
 * @returns Profile-fact status derived from confidence.
 */
function toProfileFactStatus(confidence: number): ProfileFactStatus {
  return confidence >= 0.75 ? "confirmed" : "uncertain";
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

/**
 * Compares a fact against normalized key/value inputs.
 *
 * @param fact - Existing profile fact.
 * @param key - Canonical profile key.
 * @param value - Canonical profile value.
 * @returns `true` when the fact matches the normalized key/value pair.
 */
function keyAndValueMatch(
  fact: ProfileFactRecord,
  key: string,
  value: string
): boolean {
  return fact.key === key && normalizeProfileValue(fact.value) === value;
}

/**
 * Applies deterministic validity checks for profile-memory upsert input.
 *
 * @param input - Candidate profile fact input.
 */
function assertUpsertInput(input: ProfileFactUpsertInput): void {
  if (normalizeProfileKey(input.key).length === 0) {
    throw new Error("Profile fact key cannot be empty.");
  }
  if (normalizeProfileValue(input.value).length === 0) {
    throw new Error("Profile fact value cannot be empty.");
  }
  if (input.sourceTaskId.trim().length === 0) {
    throw new Error("Profile fact sourceTaskId cannot be empty.");
  }
  if (input.source.trim().length === 0) {
    throw new Error("Profile fact source cannot be empty.");
  }
}
