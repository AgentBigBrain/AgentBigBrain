/**
 * @fileoverview Selects primary or fallback model labels per organ role from configuration.
 */

import { BrainConfig, OrganRole } from "./config";
import { GovernorId } from "./types";

/**
 * Resolves model for role from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of model for role by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `BrainConfig` (import `BrainConfig`) from `./config`.
 * - Uses `OrganRole` (import `OrganRole`) from `./config`.
 *
 * @param role - Value for role.
 * @param config - Configuration or policy settings applied here.
 * @param useFallback - Value for use fallback.
 * @returns Resulting string value.
 */
export function selectModelForRole(
  role: OrganRole,
  config: BrainConfig,
  useFallback = false
): string {
  const policy = config.routing[role];
  return useFallback ? policy.fallback : policy.primary;
}

/**
 * Resolves model for governor from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of model for governor by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `BrainConfig` (import `BrainConfig`) from `./config`.
 * - Uses `GovernorId` (import `GovernorId`) from `./types`.
 *
 * @param governorId - Stable identifier used to reference an entity or record.
 * @param config - Configuration or policy settings applied here.
 * @param useFallback - Value for use fallback.
 * @returns Resulting string value.
 */
export function selectModelForGovernor(
  governorId: GovernorId,
  config: BrainConfig,
  useFallback = false
): string {
  const policy = config.governorRouting[governorId];
  if (!policy) {
    return selectModelForRole("governor", config, useFallback);
  }
  return useFallback ? policy.fallback : policy.primary;
}

