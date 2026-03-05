/**
 * @fileoverview Canonical JSON normalization rules and hashing helpers used for deterministic artifact fingerprints.
 */

import { createHash } from "node:crypto";

interface CanonicalizationRuleV1 {
  path: string;
  mode: "ordered" | "unordered_by_key";
  sortKey?: string;
}

/**
 * Centralized canonicalization rule table (single source of truth).
 */
export const CANONICALIZATION_RULES_V1: readonly CanonicalizationRuleV1[] = [
  {
    path: "SchemaEnvelopeV1.payload",
    mode: "ordered"
  }
] as const;

/**
 * Canonicalizes nested values by lexicographically sorting object keys recursively.
 * Arrays preserve input ordering unless schema-level callers apply explicit sorting prior to hashing.
 */
export function canonicalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeForHash(entry));
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .reduce<Record<string, unknown>>((accumulator, key) => {
        accumulator[key] = canonicalizeForHash(record[key]);
        return accumulator;
      }, {});
  }

  return value;
}

/**
 * Serializes a value into deterministic canonical JSON for hashing/fingerprints.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeForHash(value));
}

/**
 * Computes a sha256 hex digest over UTF-8 input.
 */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Computes a sha256 hex digest over canonical JSON serialization.
 */
export function sha256HexFromCanonicalJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
