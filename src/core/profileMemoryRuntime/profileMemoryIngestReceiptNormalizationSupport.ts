/**
 * @fileoverview Deterministic retained ingest-receipt recovery and ordering helpers.
 */

import type { ProfileMemoryIngestReceiptRecord } from "../profileMemory";

const PROFILE_MEMORY_INGEST_RECEIPT_KEY_PREFIX = "profile_ingest_receipt_";
const PROFILE_MEMORY_RECOVERED_RECEIPT_TURN_PREFIX = "profile_ingest_receipt_turn_recovered_";
const PROFILE_MEMORY_RECOVERED_RECEIPT_FINGERPRINT_PREFIX =
  "profile_ingest_receipt_fingerprint_recovered_";
const PROFILE_MEMORY_RECOVERED_RECEIPT_TASK_PREFIX = "profile_ingest_receipt_recovered_";

/**
 * Decides whether one normalized retained receipt should replace the existing canonical winner.
 *
 * **Why it exists:**
 * Duplicate retained receipts should collapse by canonical replay recency and storage-stable
 * receipt identity instead of raw array order, so malformed persisted ordering cannot let a weaker
 * or older duplicate overwrite the canonical winner.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param existing - Current canonical retained receipt winner.
 * @param candidate - New normalized retained receipt candidate.
 * @returns `true` when the candidate is the newer canonical winner.
 */
export function shouldReplaceNormalizedProfileMemoryIngestReceipt(
  existing: ProfileMemoryIngestReceiptRecord,
  candidate: ProfileMemoryIngestReceiptRecord
): boolean {
  const existingRecordedAt = Date.parse(existing.recordedAt);
  const candidateRecordedAt = Date.parse(candidate.recordedAt);
  if (candidateRecordedAt !== existingRecordedAt) {
    return candidateRecordedAt > existingRecordedAt;
  }
  return compareNormalizedProfileMemoryIngestReceiptIdentity(existing, candidate) < 0;
}

/**
 * Orders normalized retained receipts for bounded replay-ledger retention.
 *
 * **Why it exists:**
 * The bounded receipt cap should keep the newest canonical retained receipts by replay recency even
 * when persisted array order is malformed, while still remaining deterministic for equal-timestamp
 * ties.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param left - Left retained receipt.
 * @param right - Right retained receipt.
 * @returns Negative when `left` should sort before `right`.
 */
export function compareNormalizedProfileMemoryIngestReceiptOrder(
  left: ProfileMemoryIngestReceiptRecord,
  right: ProfileMemoryIngestReceiptRecord
): number {
  const leftRecordedAt = Date.parse(left.recordedAt);
  const rightRecordedAt = Date.parse(right.recordedAt);
  if (leftRecordedAt !== rightRecordedAt) {
    return leftRecordedAt - rightRecordedAt;
  }
  return compareNormalizedProfileMemoryIngestReceiptIdentity(left, right);
}

/**
 * Repairs one retained ingest-receipt provenance task id into a stable bounded string.
 *
 * **Why it exists:**
 * Retained receipt replay metadata should not disappear just because the persisted `sourceTaskId`
 * field is blank or malformed when the canonical receipt key already proves the same-turn
 * idempotency boundary.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param value - Persisted receipt task id candidate.
 * @param receiptKey - Canonical rebuilt receipt key for deterministic fallback.
 * @returns Trimmed retained task id or one deterministic recovered fallback id.
 */
export function normalizeRecoveredReceiptSourceTaskId(
  value: unknown,
  receiptKey: string
): string {
  return normalizeRecoveredReceiptMetadataValue(
    value,
    receiptKey,
    PROFILE_MEMORY_RECOVERED_RECEIPT_TASK_PREFIX
  );
}

/**
 * Repairs one retained ingest-receipt turn id into a stable bounded string.
 *
 * **Why it exists:**
 * Otherwise valid retained receipts should stay replay-addressable when only the stored `turnId`
 * field is blank or malformed but the canonical retained `receiptKey` still survives load.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param value - Persisted receipt turn id candidate.
 * @param receiptKey - Canonical retained receipt key for deterministic fallback.
 * @returns Trimmed turn id or one deterministic recovered fallback id.
 */
export function normalizeRecoveredReceiptTurnId(
  value: unknown,
  receiptKey: string
): string {
  return normalizeRecoveredReceiptMetadataValue(
    value,
    receiptKey,
    PROFILE_MEMORY_RECOVERED_RECEIPT_TURN_PREFIX
  );
}

/**
 * Repairs one retained ingest-receipt source fingerprint into a stable bounded string.
 *
 * **Why it exists:**
 * Otherwise valid retained receipts should stay replay-addressable when only the stored
 * `sourceFingerprint` field is blank or malformed but the canonical retained `receiptKey` still
 * survives load.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param value - Persisted receipt source fingerprint candidate.
 * @param receiptKey - Canonical retained receipt key for deterministic fallback.
 * @returns Trimmed source fingerprint or one deterministic recovered fallback id.
 */
export function normalizeRecoveredReceiptSourceFingerprint(
  value: unknown,
  receiptKey: string
): string {
  return normalizeRecoveredReceiptMetadataValue(
    value,
    receiptKey,
    PROFILE_MEMORY_RECOVERED_RECEIPT_FINGERPRINT_PREFIX
  );
}

/**
 * Validates one retained canonical receipt key from storage.
 *
 * **Why it exists:**
 * When replay metadata fields are malformed, load normalization can still preserve one otherwise
 * valid retained receipt as long as the persisted canonical `receiptKey` itself survives trim and
 * still matches the bounded receipt-key contract.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param value - Persisted receipt key candidate.
 * @returns Canonical retained receipt key, or `null` when malformed.
 */
export function normalizeCanonicalRetainedReceiptKey(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      trimmed.startsWith(PROFILE_MEMORY_INGEST_RECEIPT_KEY_PREFIX) &&
      trimmed.length === PROFILE_MEMORY_INGEST_RECEIPT_KEY_PREFIX.length + 24 &&
      /^[0-9a-f]+$/.test(trimmed.slice(PROFILE_MEMORY_INGEST_RECEIPT_KEY_PREFIX.length))
    ) {
      return trimmed;
    }
  }
  return null;
}

/**
 * Detects one deterministic recovered receipt turn id.
 *
 * **Why it exists:**
 * Recovered retained turn ids should stay distinguishable from real turn ids so later loads do not
 * try to rebuild a new receipt key from fallback metadata.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param value - Normalized retained receipt turn id.
 * @returns `true` when the turn id came from receipt-key-derived recovery.
 */
export function isRecoveredReceiptTurnId(value: string): boolean {
  return value.startsWith(PROFILE_MEMORY_RECOVERED_RECEIPT_TURN_PREFIX);
}

/**
 * Detects one deterministic recovered receipt source fingerprint.
 *
 * **Why it exists:**
 * Recovered retained source fingerprints should stay distinguishable from real provenance so later
 * loads do not try to rebuild a new receipt key from fallback metadata.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param value - Normalized retained receipt source fingerprint.
 * @returns `true` when the source fingerprint came from receipt-key-derived recovery.
 */
export function isRecoveredReceiptSourceFingerprint(value: string): boolean {
  return value.startsWith(PROFILE_MEMORY_RECOVERED_RECEIPT_FINGERPRINT_PREFIX);
}

/**
 * Compares two normalized retained receipts by storage-stable identity fields.
 *
 * **Why it exists:**
 * Equal replay timestamps should still order deterministically by canonical receipt content so
 * malformed persisted array order cannot decide duplicate winner selection or bounded receipt-cap
 * retention.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param left - Left normalized retained receipt.
 * @param right - Right normalized retained receipt.
 * @returns Negative when `left` should sort before `right`.
 */
function compareNormalizedProfileMemoryIngestReceiptIdentity(
  left: ProfileMemoryIngestReceiptRecord,
  right: ProfileMemoryIngestReceiptRecord
): number {
  const receiptKeyComparison = left.receiptKey.localeCompare(right.receiptKey);
  if (receiptKeyComparison !== 0) {
    return receiptKeyComparison;
  }
  const turnIdComparison = left.turnId.localeCompare(right.turnId);
  const turnIdStrengthComparison = compareNormalizedReceiptTurnIdStrength(left.turnId, right.turnId);
  if (turnIdStrengthComparison !== 0) {
    return turnIdStrengthComparison;
  }
  if (turnIdComparison !== 0) {
    return turnIdComparison;
  }
  const sourceFingerprintComparison =
    left.sourceFingerprint.localeCompare(right.sourceFingerprint);
  const sourceFingerprintStrengthComparison = compareNormalizedReceiptSourceFingerprintStrength(
    left.sourceFingerprint,
    right.sourceFingerprint
  );
  if (sourceFingerprintStrengthComparison !== 0) {
    return sourceFingerprintStrengthComparison;
  }
  if (sourceFingerprintComparison !== 0) {
    return sourceFingerprintComparison;
  }
  const sourceTaskIdStrengthComparison = compareNormalizedReceiptSourceTaskIdStrength(
    left.sourceTaskId,
    right.sourceTaskId
  );
  if (sourceTaskIdStrengthComparison !== 0) {
    return sourceTaskIdStrengthComparison;
  }
  return left.sourceTaskId.localeCompare(right.sourceTaskId);
}

/**
 * Orders retained receipt task ids by provenance strength.
 *
 * **Why it exists:**
 * When duplicate retained receipts tie on canonical replay time, a real trimmed task id should win
 * over a deterministic recovered fallback so normalization keeps the stronger bounded provenance.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param left - Left retained receipt task id.
 * @param right - Right retained receipt task id.
 * @returns Negative when `left` should sort before `right`.
 */
function compareNormalizedReceiptSourceTaskIdStrength(
  left: string,
  right: string
): number {
  return Number(isRecoveredReceiptSourceTaskId(right)) - Number(isRecoveredReceiptSourceTaskId(left));
}

/**
 * Orders retained receipt turn ids by provenance strength.
 *
 * **Why it exists:**
 * Equal-time retained duplicates should keep one real trimmed `turnId` over a deterministic
 * recovered fallback so stronger replay metadata survives normalization.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param left - Left retained receipt turn id.
 * @param right - Right retained receipt turn id.
 * @returns Negative when `left` should sort before `right`.
 */
function compareNormalizedReceiptTurnIdStrength(left: string, right: string): number {
  return Number(isRecoveredReceiptTurnId(right)) - Number(isRecoveredReceiptTurnId(left));
}

/**
 * Orders retained receipt source fingerprints by provenance strength.
 *
 * **Why it exists:**
 * Equal-time retained duplicates should keep one real trimmed `sourceFingerprint` over a
 * deterministic recovered fallback so stronger replay metadata survives normalization.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param left - Left retained receipt source fingerprint.
 * @param right - Right retained receipt source fingerprint.
 * @returns Negative when `left` should sort before `right`.
 */
function compareNormalizedReceiptSourceFingerprintStrength(left: string, right: string): number {
  return Number(isRecoveredReceiptSourceFingerprint(right)) -
    Number(isRecoveredReceiptSourceFingerprint(left));
}

/**
 * Detects one deterministic recovered receipt task id.
 *
 * **Why it exists:**
 * Recovered retained receipt provenance should remain distinguishable from original bounded task ids
 * so duplicate winner selection can prefer stronger persisted provenance when replay timestamps tie.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param value - Normalized retained receipt task id.
 * @returns `true` when the task id came from receipt-key-derived recovery.
 */
function isRecoveredReceiptSourceTaskId(value: string): boolean {
  return value.startsWith(PROFILE_MEMORY_RECOVERED_RECEIPT_TASK_PREFIX);
}

/**
 * Repairs one retained receipt metadata field into a stable bounded string.
 *
 * **Why it exists:**
 * The retained receipt recovery lane should use one shared deterministic fallback shape for replay
 * metadata fields so recovery markers remain explicit and stable across reloads.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param value - Persisted metadata candidate.
 * @param receiptKey - Canonical retained receipt key for deterministic fallback.
 * @param prefix - Recovery marker prefix for this metadata field.
 * @returns Trimmed metadata value or one deterministic recovered fallback id.
 */
function normalizeRecoveredReceiptMetadataValue(
  value: unknown,
  receiptKey: string,
  prefix: string
): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return `${prefix}${receiptKey.slice(-24)}`;
}
