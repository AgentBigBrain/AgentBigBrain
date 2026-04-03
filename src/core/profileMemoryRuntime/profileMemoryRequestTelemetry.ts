/**
 * @fileoverview Mutable request-path telemetry helpers for bounded profile-memory store access.
 */

import type { ProfileMemoryRequestTelemetry } from "./contracts";

/**
 * Creates a fresh mutable telemetry bag for one request path.
 *
 * @returns Request-scoped telemetry counters.
 */
export function createProfileMemoryRequestTelemetry(): ProfileMemoryRequestTelemetry {
  return {
    storeLoadCount: 0
  };
}

/**
 * Increments the request-scoped store-load counter when telemetry is enabled.
 *
 * @param telemetry - Optional request-scoped telemetry bag.
 */
export function recordProfileMemoryStoreLoad(
  telemetry: ProfileMemoryRequestTelemetry | null | undefined
): void {
  if (telemetry) {
    telemetry.storeLoadCount += 1;
  }
}
