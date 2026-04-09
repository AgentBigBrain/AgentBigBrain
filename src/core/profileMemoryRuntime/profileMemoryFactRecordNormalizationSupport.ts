/**
 * @fileoverview Focused helpers for fail-closed retained flat-fact semantic normalization.
 */

import type { ProfileFactRecord } from "../profileMemory";
import { canonicalizeProfileKey, normalizeProfileValue } from "./profileMemoryNormalization";

/**
 * Canonicalizes one retained fact key into a storage-stable compatibility-lane key.
 *
 * **Why it exists:**
 * Retained facts whose keys normalize to blank semantics should fail closed during load instead of
 * staying visible on compatibility reads or legacy graph repair with empty meaning.
 *
 * **What it talks to:**
 * - Uses `canonicalizeProfileKey` (import) from `./profileMemoryNormalization`.
 *
 * @param value - Persisted fact key candidate.
 * @returns Canonical fact key, or `null` when normalization removes all semantic content.
 */
export function normalizeRetainedFactKey(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = canonicalizeProfileKey(value);
  return normalized.length > 0 ? normalized : null;
}

/**
 * Canonicalizes one retained fact value into a storage-stable compatibility-lane value.
 *
 * **Why it exists:**
 * Retained facts whose values collapse to blank after normalization should fail closed during load
 * instead of leaking semantically empty payloads through direct reads or planner/query surfaces.
 *
 * **What it talks to:**
 * - Uses `normalizeProfileValue` (import) from `./profileMemoryNormalization`.
 *
 * @param value - Persisted fact value candidate.
 * @returns Canonical fact value, or `null` when normalization removes all semantic content.
 */
export function normalizeRetainedFactValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = normalizeProfileValue(value);
  return normalized.length > 0 ? normalized : null;
}

/**
 * Canonicalizes one retained fact source-task id into bounded required provenance.
 *
 * **Why it exists:**
 * Live fact upserts already reject blank `sourceTaskId`, so encrypted reload should not keep
 * provenance-invalid retained facts alive just because the raw payload still contained a string.
 *
 * **What it talks to:**
 * - Uses local string normalization logic within this module.
 *
 * @param value - Persisted fact source-task id candidate.
 * @returns Trimmed fact source-task id, or `null` when blank.
 */
export function normalizeRetainedFactSourceTaskId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Canonicalizes one retained fact source identifier into bounded required provenance.
 *
 * **Why it exists:**
 * Live fact upserts already reject blank `source`, so encrypted reload should not keep
 * provenance-invalid retained facts alive or route compatibility and graph repair through an empty
 * source identifier.
 *
 * **What it talks to:**
 * - Uses local string normalization logic within this module.
 *
 * @param value - Persisted fact source identifier candidate.
 * @returns Trimmed lowercased source id, or `null` when blank.
 */
export function normalizeRetainedFactSource(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Canonicalizes one retained fact id into a stable compatibility-lane identifier.
 *
 * @param value - Persisted fact id candidate.
 * @returns Trimmed fact id, or `null` when malformed.
 */
export function normalizeRetainedFactId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Canonicalizes one retained fact status into the bounded compatibility vocabulary.
 *
 * @param value - Persisted fact status candidate.
 * @returns Canonical retained fact status, or `null` when malformed.
 */
export function normalizeRetainedFactStatus(
  value: unknown
): ProfileFactRecord["status"] | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "confirmed" || trimmed === "uncertain" || trimmed === "superseded") {
    return trimmed;
  }
  return null;
}

/**
 * Fail-closes one retained fact confidence value into the bounded compatibility lane.
 *
 * @param value - Persisted confidence candidate.
 * @returns Canonical confidence in the closed interval `[0, 1]`, or `0` when malformed.
 */
export function normalizeRetainedFactConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : 0;
}
