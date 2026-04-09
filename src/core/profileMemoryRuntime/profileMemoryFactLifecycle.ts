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
import { getProfileMemoryFamilyRegistryEntry } from "./profileMemoryFamilyRegistry";
import { inferGovernanceFamilyForNormalizedKey } from "./profileMemoryGovernanceFamilyInference";
import {
  PROFILE_MEMORY_SCHEMA_VERSION
} from "./profileMemoryState";
import { createEmptyProfileMemoryGraphState } from "./profileMemoryGraphState";
import { safeIsoOrNow } from "./profileMemoryStateNormalization";
import { MEMORY_REVIEW_FACT_CORRECTION_SOURCE } from "./profileMemoryTruthGovernanceSources";
import type { ProfileMemoryDisplacementPolicy } from "./profileMemoryTruthGovernanceContracts";

/**
 * Upserts one temporal profile fact under the code-owned family displacement policy.
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
  const family = inferGovernanceFamilyForNormalizedKey(key, value);
  const displacementPolicy = getProfileMemoryFamilyRegistryEntry(family).displacementPolicy;
  const confidence = normalizeConfidence(input.confidence);
  const observedAt = safeIsoOrNow(input.observedAt);
  const nowIso = new Date().toISOString();
  const status = toProfileFactStatus(confidence);

  const nextFacts: ProfileFactRecord[] = [];
  const supersededFactIds: string[] = [];
  const activeSameKeyFacts: ProfileFactRecord[] = [];

  for (const fact of state.facts) {
    if (isActiveFact(fact) && fact.key === key) {
      activeSameKeyFacts.push(fact);
      continue;
    }
    nextFacts.push(fact);
  }

  const matchingActiveFacts = activeSameKeyFacts.filter((fact) =>
    keyAndValueMatch(fact, key, value)
  );
  const conflictingActiveFacts = activeSameKeyFacts.filter(
    (fact) => !keyAndValueMatch(fact, key, value)
  );
  const conflictDisposition = resolveConflictDisposition(displacementPolicy, input.source);

  let applied = false;
  let winnerFact: ProfileFactRecord | null = null;

  if (matchingActiveFacts.length > 0) {
    winnerFact = refreshProfileFact(matchingActiveFacts[0], status, confidence, nowIso, input);
    nextFacts.push(winnerFact);
    applied = true;
    for (const duplicate of [...matchingActiveFacts.slice(1), ...conflictingActiveFacts]) {
      supersededFactIds.push(duplicate.id);
      nextFacts.push(toSupersededFact(duplicate, nowIso));
    }
  } else {
    const challengerStatus =
      conflictingActiveFacts.length > 0 && conflictDisposition === "preserve"
        ? "uncertain"
        : status;
    if (conflictingActiveFacts.length > 0 && conflictDisposition === "replace") {
      for (const conflictingFact of conflictingActiveFacts) {
        supersededFactIds.push(conflictingFact.id);
        nextFacts.push(toSupersededFact(conflictingFact, nowIso));
      }
    } else {
      nextFacts.push(...conflictingActiveFacts);
    }
    winnerFact = createProfileFactRecord(input, {
      key,
      value,
      confidence,
      observedAt,
      status: challengerStatus,
      nowIso
    });
    nextFacts.push(winnerFact);
    applied = true;
  }

  return {
    nextState: {
      schemaVersion: PROFILE_MEMORY_SCHEMA_VERSION,
      updatedAt: nowIso,
      facts: nextFacts,
      episodes: state.episodes ?? [],
      ingestReceipts: state.ingestReceipts ?? [],
      graph: state.graph ?? createEmptyProfileMemoryGraphState(nowIso)
    },
    upsertedFact: winnerFact ?? createProfileFactRecord(input, {
      key,
      value,
      confidence,
      observedAt,
      status,
      nowIso
    }),
    supersededFactIds,
    applied
  };
}

type ProfileFactConflictDisposition = "replace" | "preserve" | "append";

/**
 * Resolves how one conflicting same-key fact family should behave during canonical upsert.
 *
 * @param displacementPolicy - Code-owned family displacement policy from the registry.
 * @param source - Candidate source under evaluation.
 * @returns Conflict disposition for the canonical fact lifecycle.
 */
function resolveConflictDisposition(
  displacementPolicy: ProfileMemoryDisplacementPolicy,
  source: string
): ProfileFactConflictDisposition {
  if (source.trim().toLowerCase() === MEMORY_REVIEW_FACT_CORRECTION_SOURCE) {
    return "replace";
  }

  switch (displacementPolicy) {
    case "replace_authoritative_successor":
    case "resolution_only":
      return "replace";
    case "preserve_prior_on_conflict":
    case "not_applicable":
      return "preserve";
    case "append_multi_value":
      return "append";
  }
}

/**
 * Refreshes one existing active fact when the incoming candidate matches the same normalized key
 * and value.
 *
 * @param fact - Existing active fact selected as the canonical winner.
 * @param status - Candidate-derived next status.
 * @param confidence - Candidate-derived confidence.
 * @param nowIso - Mutation timestamp for the refresh.
 * @param input - Original upsert input carrying optional mutation-audit metadata.
 * @returns Refreshed canonical fact record.
 */
function refreshProfileFact(
  fact: ProfileFactRecord,
  status: ProfileFactStatus,
  confidence: number,
  nowIso: string,
  input: ProfileFactUpsertInput
): ProfileFactRecord {
  return {
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
}

/**
 * Marks one previously active fact as superseded.
 *
 * @param fact - Existing active fact to close.
 * @param nowIso - Mutation timestamp for the supersession.
 * @returns Superseded fact record.
 */
function toSupersededFact(
  fact: ProfileFactRecord,
  nowIso: string
): ProfileFactRecord {
  return {
    ...fact,
    status: "superseded",
    supersededAt: nowIso,
    lastUpdatedAt: nowIso
  };
}

/**
 * Creates one canonical fact record for a new winner or preserved challenger write.
 *
 * @param input - Original upsert input carrying source and sensitivity metadata.
 * @param options - Normalized canonical fact fields derived by the lifecycle seam.
 * @returns New canonical fact record.
 */
function createProfileFactRecord(
  input: ProfileFactUpsertInput,
  options: {
    key: string;
    value: string;
    confidence: number;
    observedAt: string;
    status: ProfileFactStatus;
    nowIso: string;
  }
): ProfileFactRecord {
  return {
    id: makeId("profile_fact"),
    key: options.key,
    value: options.value,
    sensitive: input.sensitive,
    status: options.status,
    confidence: options.confidence,
    sourceTaskId: input.sourceTaskId,
    source: input.source,
    observedAt: options.observedAt,
    confirmedAt: options.status === "confirmed" ? options.nowIso : null,
    supersededAt: null,
    lastUpdatedAt: options.nowIso,
    mutationAudit: input.mutationAudit ?? undefined
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
