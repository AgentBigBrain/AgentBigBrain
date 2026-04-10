/**
 * @fileoverview Stable-ref rekey helpers for bounded profile-memory graph mutation lanes.
 */

import type {
  ProfileMemoryGraphClaimRecord,
  ProfileMemoryGraphEventRecord,
  ProfileMemoryGraphObservationRecord
} from "./profileMemoryGraphContracts";
import { rebuildProfileMemoryGraphEnvelope } from "./profileMemoryGraphStateSupport";

/**
 * Rekeys one bounded graph-record lane that currently resolves to one stable ref id.
 *
 * @param input - Canonical records plus one deterministic from/to stable-ref rewrite request.
 * @returns Updated records, changed flag, and touched record ids.
 */
export function rekeyProfileMemoryGraphRecords<
  TRecord extends
    | ProfileMemoryGraphObservationRecord
    | ProfileMemoryGraphClaimRecord
    | ProfileMemoryGraphEventRecord
>(input: {
  observations: readonly TRecord[];
  fromStableRefId: string;
  toStableRefId: string;
  recordedAt: string;
  getRecordId: (record: TRecord) => string;
  resolveStableRefId: (record: TRecord) => string | null;
  schemaName: string;
}): {
  nextRecords: TRecord[];
  touchedRecordIds: string[];
  changed: boolean;
} {
  let changed = false;
  const touchedRecordIds: string[] = [];
  const nextRecords = input.observations.map((record) => {
    if (input.resolveStableRefId(record) !== input.fromStableRefId) {
      return record;
    }
    touchedRecordIds.push(input.getRecordId(record));
    if (record.payload.stableRefId === input.toStableRefId) {
      return record;
    }
    changed = true;
    return rebuildStableRefEnvelope(
      record,
      input.schemaName,
      input.toStableRefId,
      input.recordedAt
    );
  });
  return { nextRecords, touchedRecordIds, changed };
}

/**
 * Rebuilds one graph envelope with a replacement stable ref id while preserving createdAt.
 *
 * @param record - Existing graph envelope to rewrite.
 * @param schemaName - Schema name for the rebuilt graph record.
 * @param stableRefId - Replacement stable ref id.
 * @param recordedAt - Timestamp for fallback createdAt repair.
 * @returns Rebuilt graph envelope with the replacement stable ref.
 */
function rebuildStableRefEnvelope<
  TRecord extends
    | ProfileMemoryGraphObservationRecord
    | ProfileMemoryGraphClaimRecord
    | ProfileMemoryGraphEventRecord
>(
  record: TRecord,
  schemaName: string,
  stableRefId: string,
  recordedAt: string
): TRecord {
  return rebuildProfileMemoryGraphEnvelope<
    TRecord["payload"],
    TRecord["payload"]
  >({
    record,
    schemaName,
    payload: {
      ...record.payload,
      stableRefId
    },
    fallbackCreatedAt: recordedAt
  }) as TRecord;
}
