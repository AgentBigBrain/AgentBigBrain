/**
 * @fileoverview Stage 6.75 migration-parity normalizer for deterministic V1 artifact comparison during compatibility checks.
 */

import { canonicalizeForHash } from "./canonicalizationRules";

export interface Stage675NormalizedArtifact {
  schemaName: string;
  schemaVersion: "v1";
  payload: unknown;
}

/**
 * Normalizes artifact for parity v1 into a stable shape for `stage6_75MigrationParity` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for artifact for parity v1 so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses `canonicalizeForHash` (import `canonicalizeForHash`) from `./canonicalizationRules`.
 *
 * @param payload - Structured input object for this operation.
 * @returns Computed `Stage675NormalizedArtifact` result.
 */
export function normalizeArtifactForParityV1(payload: unknown): Stage675NormalizedArtifact {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Migration parity normalization requires object payload input.");
  }
  const candidate = payload as {
    schemaName?: unknown;
    schemaVersion?: unknown;
    payload?: unknown;
  };
  if (typeof candidate.schemaName !== "string") {
    throw new Error("Migration parity normalization requires schemaName string.");
  }
  if (candidate.schemaVersion !== "v1") {
    throw new Error("Migration parity normalization currently supports schemaVersion 'v1' only.");
  }
  return {
    schemaName: candidate.schemaName,
    schemaVersion: "v1",
    payload: canonicalizeForHash(candidate.payload)
  };
}
