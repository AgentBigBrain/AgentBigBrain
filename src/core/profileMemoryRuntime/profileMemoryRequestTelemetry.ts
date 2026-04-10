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
    storeLoadCount: 0,
    ingestOperationCount: 0,
    retrievalOperationCount: 0,
    synthesisOperationCount: 0,
    renderOperationCount: 0,
    promptMemoryOwnerCount: 0,
    promptMemorySurfaceCount: 0,
    mixedMemoryOwnerDecisionCount: 0,
    aliasSafetyDecisionCount: 0,
    identitySafetyDecisionCount: 0,
    selfIdentityParityCheckCount: 0,
    selfIdentityParityMismatchCount: 0
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

/**
 * Increments the request-scoped ingest-operation counter when telemetry is enabled.
 *
 * @param telemetry - Optional request-scoped telemetry bag.
 */
export function recordProfileMemoryIngestOperation(
  telemetry: ProfileMemoryRequestTelemetry | null | undefined
): void {
  if (telemetry) {
    telemetry.ingestOperationCount += 1;
  }
}

/**
 * Increments the request-scoped retrieval-operation counter when telemetry is enabled.
 *
 * @param telemetry - Optional request-scoped telemetry bag.
 */
export function recordProfileMemoryRetrievalOperation(
  telemetry: ProfileMemoryRequestTelemetry | null | undefined
): void {
  if (telemetry) {
    telemetry.retrievalOperationCount += 1;
  }
}

/**
 * Increments the request-scoped synthesis-operation counter when telemetry is enabled.
 *
 * @param telemetry - Optional request-scoped telemetry bag.
 */
export function recordProfileMemorySynthesisOperation(
  telemetry: ProfileMemoryRequestTelemetry | null | undefined
): void {
  if (telemetry) {
    telemetry.synthesisOperationCount += 1;
  }
}

/**
 * Increments the request-scoped render-operation counter when telemetry is enabled.
 *
 * @param telemetry - Optional request-scoped telemetry bag.
 */
export function recordProfileMemoryRenderOperation(
  telemetry: ProfileMemoryRequestTelemetry | null | undefined
): void {
  if (telemetry) {
    telemetry.renderOperationCount += 1;
  }
}

/**
 * Records bounded prompt-memory owner metrics for the current request.
 *
 * @param telemetry - Optional request-scoped telemetry bag.
 * @param ownerCount - Count of memory owners contributing to the final prompt surface.
 * @param surfaceCount - Count of prompt memory surfaces contributing to the final prompt.
 */
export function recordProfileMemoryPromptSurfaceMetrics(
  telemetry: ProfileMemoryRequestTelemetry | null | undefined,
  ownerCount: number,
  surfaceCount: number
): void {
  if (!telemetry) {
    return;
  }
  telemetry.promptMemoryOwnerCount = Math.max(telemetry.promptMemoryOwnerCount, ownerCount);
  telemetry.promptMemorySurfaceCount = Math.max(telemetry.promptMemorySurfaceCount, surfaceCount);
  if (ownerCount > 1) {
    telemetry.mixedMemoryOwnerDecisionCount += 1;
  }
}

/**
 * Increments the request-scoped alias-safety decision counter when telemetry is enabled.
 *
 * @param telemetry - Optional request-scoped telemetry bag.
 */
export function recordProfileMemoryAliasSafetyDecision(
  telemetry: ProfileMemoryRequestTelemetry | null | undefined
): void {
  if (telemetry) {
    telemetry.aliasSafetyDecisionCount += 1;
  }
}

/**
 * Increments the request-scoped identity-safety decision counter when telemetry is enabled.
 *
 * @param telemetry - Optional request-scoped telemetry bag.
 */
export function recordProfileMemoryIdentitySafetyDecision(
  telemetry: ProfileMemoryRequestTelemetry | null | undefined
): void {
  if (telemetry) {
    telemetry.identitySafetyDecisionCount += 1;
  }
}

/**
 * Records one self-identity parity check and optional mismatch when telemetry is enabled.
 *
 * @param telemetry - Optional request-scoped telemetry bag.
 * @param matched - Whether the compared self-identity signals stayed in parity.
 */
export function recordProfileMemorySelfIdentityParity(
  telemetry: ProfileMemoryRequestTelemetry | null | undefined,
  matched: boolean
): void {
  if (!telemetry) {
    return;
  }
  telemetry.selfIdentityParityCheckCount += 1;
  if (!matched) {
    telemetry.selfIdentityParityMismatchCount += 1;
  }
}
