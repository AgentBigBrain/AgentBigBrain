/**
 * @fileoverview Family-level sensitivity-floor helpers for governed profile-memory facts.
 */

import type { ProfileFactUpsertInput } from "../profileMemory";
import { applyProfileMemoryMinimumSensitivityFloor } from "./profileMemoryFamilyRegistry";
import { inferGovernanceFamilyForNormalizedKey } from "./profileMemoryGovernanceFamilyInference";
import type { ProfileMemoryGovernanceFamily } from "./profileMemoryTruthGovernanceContracts";

interface ProfileMemoryFactLikeSensitivityInput {
  key: string;
  value: string;
  sensitive: boolean;
}

/**
 * Resolves the effective sensitivity bit for one fact-like record under the code-owned family
 * policy plus any bounded key-level heuristic owned by that family.
 *
 * @param key - Canonical fact key under evaluation.
 * @param sensitive - Existing sensitivity bit on the fact-like record.
 * @param family - Canonical family assigned by governance.
 * @returns Effective sensitivity after family policy is enforced.
 */
export function resolveProfileMemoryEffectiveSensitivity(
  key: string,
  sensitive: boolean,
  family: ProfileMemoryGovernanceFamily
): boolean {
  return applyProfileMemoryMinimumSensitivityFloor(family, sensitive, key);
}

/**
 * Evaluates whether one stored fact should be treated as effectively sensitive after family policy
 * and bounded key-level heuristics are applied.
 *
 * @param fact - Stored fact-like record under evaluation.
 * @returns `true` when the fact should stay behind sensitive-read approval.
 */
export function isStoredProfileFactEffectivelySensitive(
  fact: ProfileMemoryFactLikeSensitivityInput
): boolean {
  const family = inferGovernanceFamilyForNormalizedKey(
    fact.key.trim().toLowerCase(),
    fact.value
  );
  return resolveProfileMemoryEffectiveSensitivity(fact.key, fact.sensitive, family);
}

/**
 * Applies the code-owned family-level minimum sensitivity floor to one fact candidate before it
 * reaches canonical mutation.
 *
 * @param candidate - Fact candidate under governance.
 * @param family - Canonical family assigned by governance.
 * @returns Fact candidate with the family-level sensitivity floor enforced.
 */
export function applyProfileMemoryMinimumSensitivityFloorToFactCandidate(
  candidate: ProfileFactUpsertInput,
  family: ProfileMemoryGovernanceFamily
): ProfileFactUpsertInput {
  const effectiveSensitive = resolveProfileMemoryEffectiveSensitivity(
    candidate.key,
    candidate.sensitive,
    family
  );
  if (effectiveSensitive === candidate.sensitive) {
    return candidate;
  }
  return {
    ...candidate,
    sensitive: effectiveSensitive
  };
}
