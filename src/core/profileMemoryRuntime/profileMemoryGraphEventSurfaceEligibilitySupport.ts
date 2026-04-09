/**
 * @fileoverview Active-surface eligibility helpers for additive graph event records.
 */

import type { ProfileMemoryGraphEventRecord } from "./profileMemoryGraphContracts";
import { normalizeProfileMemoryGraphSourceRecordId } from "./profileMemoryGraphStateSupport";

/**
 * Evaluates whether one retained graph event still belongs on the bounded active event surface.
 *
 * **Why it exists:**
 * Live episode-to-graph mutation only keeps non-redacted unresolved episode candidates on the
 * active event surface. Older or malformed retained graph state can still carry active-looking
 * events after their episode projection lineage has vanished or when they came from source tiers
 * that live episode governance would quarantine, and those records should remain canonical-only
 * for audit instead of receiving replay protection or pinning retained observations.
 *
 * **What it talks to:**
 * - Uses local graph event payload fields within this module.
 *
 * @param event - Canonical graph event under evaluation.
 * @returns `true` when the event is still active, non-redacted, episode-backed, source-tier-valid,
 *   and linked to at least one surviving projection source when retained episodes exist.
 */
export function isProfileMemoryGraphEventActiveSurfaceEligible(input: {
  event: ProfileMemoryGraphEventRecord;
  validEpisodeProjectionSourceIds?: ReadonlySet<string>;
}
): boolean {
  const family = typeof input.event.payload.family === "string"
    ? input.event.payload.family.trim()
    : "";
  if (
    input.event.payload.redactionState === "redacted" ||
    input.event.payload.validTo !== null ||
    family !== "episode.candidate" ||
    input.event.payload.sourceTier === "validated_structured_candidate" ||
    input.event.payload.sourceTier === "reconciliation_or_projection"
  ) {
    return false;
  }
  const normalizedProjectionSourceIds = input.event.payload.projectionSourceIds.flatMap(
    (projectionSourceId) => {
      const normalizedProjectionSourceId =
        normalizeProfileMemoryGraphSourceRecordId(projectionSourceId);
      return normalizedProjectionSourceId === null ? [] : [normalizedProjectionSourceId];
    }
  );
  if (input.validEpisodeProjectionSourceIds === undefined) {
    return true;
  }
  return (
    normalizedProjectionSourceIds.length === 0 ||
    normalizedProjectionSourceIds.some((projectionSourceId) =>
      input.validEpisodeProjectionSourceIds?.has(projectionSourceId)
    )
  );
}
