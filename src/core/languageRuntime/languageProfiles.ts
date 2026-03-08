/**
 * @fileoverview Canonical language-profile selection for non-safety tokenization.
 */

import type { LanguageProfileId } from "./contracts";

export const DEFAULT_LANGUAGE_PROFILE_ID: LanguageProfileId = "generic_en";

/**
 * Resolves a bounded language profile for deterministic non-safety text handling.
 *
 * @param requestedProfileId - Optional requested profile id.
 * @returns Stable supported profile id.
 */
export function resolveLanguageProfileId(
  requestedProfileId?: LanguageProfileId | null
): LanguageProfileId {
  return requestedProfileId ?? DEFAULT_LANGUAGE_PROFILE_ID;
}
