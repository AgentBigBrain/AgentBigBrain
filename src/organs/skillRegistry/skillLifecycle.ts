/**
 * @fileoverview Deterministic manifest lifecycle helpers for the governed skill registry.
 */

import type { SkillManifest } from "./contracts";
import { applySkillManifestUpdate } from "./skillManifest";
import type { SkillVerificationResult } from "./skillVerificationContracts";

/**
 * Applies a verification result to a manifest and updates lifecycle timestamps.
 *
 * @param manifest - Existing manifest.
 * @param verification - Verification result to persist.
 * @param nowIso - Timestamp applied to the manifest.
 * @returns Updated manifest after verification.
 */
export function applySkillVerificationResult(
  manifest: SkillManifest,
  verification: SkillVerificationResult,
  nowIso: string
): SkillManifest {
  return applySkillManifestUpdate(
    manifest,
    {
      verificationStatus: verification.status,
      verificationVerifiedAt: verification.verifiedAt,
      verificationFailureReason: verification.failureReason,
      updatedAt: nowIso
    },
    nowIso
  );
}
