/**
 * @fileoverview Shared memory-access audit append helpers for the memory brokerage subsystem.
 */

import {
  MemoryAccessAuditStore,
  type MemoryAccessDomainLane
} from "../../core/memoryAccessAudit";
import type { MemoryAccessAuditAppendOptions, MemoryDomainLane } from "./contracts";

/**
 * Converts broker lanes into the audit-store lane union.
 *
 * @param lanes - Broker domain lanes to normalize for audit storage.
 * @returns Audit-store lane values in the original order.
 */
function toAuditDomainLanes(lanes: readonly MemoryDomainLane[]): MemoryAccessDomainLane[] {
  return lanes.map((lane) => lane as MemoryAccessDomainLane);
}

/**
 * Appends one memory-access audit event and degrades non-fatally on audit-store failure.
 *
 * @param auditStore - Audit store used for append-only memory access traces.
 * @param taskId - Task identifier associated with the retrieval.
 * @param query - User request query used for retrieval.
 * @param retrievedCount - Count of retrieved readable facts.
 * @param retrievedEpisodeCount - Count of retrieved episode summaries.
 * @param redactedCount - Count of sensitive fields redacted before egress.
 * @param lanes - Domain lanes attributed to the retrieval.
 * @param options - Optional probing-specific metadata.
 * @returns Promise resolving when the append attempt completes.
 */
export async function appendMemoryAccessAudit(
  auditStore: MemoryAccessAuditStore,
  taskId: string,
  query: string,
  retrievedCount: number,
  retrievedEpisodeCount: number,
  redactedCount: number,
  lanes: readonly MemoryDomainLane[],
  options?: MemoryAccessAuditAppendOptions
): Promise<void> {
  try {
    await auditStore.appendEvent({
      taskId,
      query,
      storeLoadCount: options?.storeLoadCount,
      retrievedCount,
      retrievedEpisodeCount: options?.retrievedEpisodeCount ?? retrievedEpisodeCount,
      redactedCount,
      domainLanes: toAuditDomainLanes(lanes),
      eventType: options?.eventType,
      probeSignals: options?.probeSignals,
      probeWindowSize: options?.probeWindowSize,
      probeMatchCount: options?.probeMatchCount,
      probeMatchRatio: options?.probeMatchRatio
    });
  } catch (error) {
    console.error(
      `[MemoryBroker] non-fatal memory-access-audit append failure for task ${taskId}: ${(error as Error).message}`
    );
  }
}
