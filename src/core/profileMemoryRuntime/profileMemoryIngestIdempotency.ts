/**
 * @fileoverview Deterministic turn-local ingest-receipt helpers for bounded profile-memory idempotency.
 */

import { createHash } from "node:crypto";

import type {
  ProfileMemoryIngestReceiptRecord,
  ProfileMemoryState
} from "../profileMemory";
import type { ProfileMemoryWriteProvenance } from "./contracts";

const MAX_PROFILE_MEMORY_INGEST_RECEIPTS = 256;

/**
 * Builds one stable receipt key for a turn-local provenance boundary.
 *
 * @param provenance - Bounded write provenance for the current ingest attempt.
 * @returns Deterministic receipt key, or `null` when provenance is too sparse.
 */
export function buildProfileMemoryIngestReceiptKey(
  provenance: ProfileMemoryWriteProvenance | null | undefined
): string | null {
  if (!provenance?.turnId || !provenance.sourceFingerprint) {
    return null;
  }
  return `profile_ingest_receipt_${createHash("sha256")
    .update([provenance.turnId.trim(), provenance.sourceFingerprint.trim()].join("\n"))
    .digest("hex")
    .slice(0, 24)}`;
}

/**
 * Looks up one existing ingest receipt for the current bounded provenance payload.
 *
 * @param state - Current profile-memory state.
 * @param provenance - Bounded write provenance for the current ingest attempt.
 * @returns Matching receipt, or `null` when the turn has not been recorded yet.
 */
export function findProfileMemoryIngestReceipt(
  state: ProfileMemoryState,
  provenance: ProfileMemoryWriteProvenance | null | undefined
): ProfileMemoryIngestReceiptRecord | null {
  const receiptKey = buildProfileMemoryIngestReceiptKey(provenance);
  if (!receiptKey) {
    return null;
  }
  return state.ingestReceipts.find((receipt) => receipt.receiptKey === receiptKey) ?? null;
}

/**
 * Records one bounded ingest receipt after a canonical write succeeds.
 *
 * @param state - Current profile-memory state after canonical mutation.
 * @param input - Receipt metadata for the successful ingest attempt.
 * @returns State with a bounded receipt ledger.
 */
export function recordProfileMemoryIngestReceipt(
  state: ProfileMemoryState,
  input: {
    provenance: ProfileMemoryWriteProvenance | null | undefined;
    sourceTaskId: string;
    recordedAt: string;
  }
): ProfileMemoryState {
  const receiptKey = buildProfileMemoryIngestReceiptKey(input.provenance);
  if (!receiptKey || !input.provenance?.turnId || !input.provenance.sourceFingerprint) {
    return state;
  }
  if (state.ingestReceipts.some((receipt) => receipt.receiptKey === receiptKey)) {
    return state;
  }

  const nextReceipt: ProfileMemoryIngestReceiptRecord = {
    receiptKey,
    turnId: input.provenance.turnId,
    sourceFingerprint: input.provenance.sourceFingerprint,
    sourceTaskId: input.sourceTaskId,
    recordedAt: input.recordedAt
  };
  return {
    ...state,
    ingestReceipts: [...state.ingestReceipts, nextReceipt].slice(-MAX_PROFILE_MEMORY_INGEST_RECEIPTS)
  };
}
