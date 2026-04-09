/**
 * @fileoverview Canonical profile-memory state normalization helpers for persisted envelopes.
 */

import type {
  ProfileFactRecord,
  ProfileMemoryIngestReceiptRecord,
  ProfileMemoryState,
  ProfileMutationAuditMetadataV1
} from "../profileMemory";
import {
  buildProfileMemoryIngestReceiptKey,
  MAX_PROFILE_MEMORY_INGEST_RECEIPTS
} from "./profileMemoryIngestIdempotency";
import {
  normalizeRetainedFactConfidence,
  normalizeRetainedFactId,
  normalizeRetainedFactKey,
  normalizeRetainedFactSource,
  normalizeRetainedFactSourceTaskId,
  normalizeRetainedFactStatus,
  normalizeRetainedFactValue
} from "./profileMemoryFactRecordNormalizationSupport";
import {
  dedupeNormalizedRetainedFacts,
  repairNormalizedRetainedSemanticDuplicateFacts
} from "./profileMemoryRetainedFactDeduplicationSupport";
import { isRetainedFactSupportedByTruthGovernance } from "./profileMemoryRetainedFactGovernanceSupport";
import { isStoredProfileFactEffectivelySensitive } from "./profileMemoryFactSensitivity";
import {
  repairNormalizedRetainedPreserveConflictFacts,
  repairNormalizedRetainedReplaceConflictFacts
} from "./profileMemoryRetainedFactConflictRepairSupport";
import { repairNormalizedRetainedMixedPolicyConflictFacts } from "./profileMemoryRetainedMixedPolicyConflictRepairSupport";
import {
  compareNormalizedProfileMemoryIngestReceiptOrder,
  isRecoveredReceiptSourceFingerprint,
  isRecoveredReceiptTurnId,
  normalizeCanonicalRetainedReceiptKey,
  normalizeRecoveredReceiptSourceFingerprint,
  normalizeRecoveredReceiptSourceTaskId,
  normalizeRecoveredReceiptTurnId,
  shouldReplaceNormalizedProfileMemoryIngestReceipt
} from "./profileMemoryIngestReceiptNormalizationSupport";
import { normalizeProfileMemoryGraphState } from "./profileMemoryGraphState";
import { normalizeProfileMemoryEpisodes } from "./profileMemoryEpisodeNormalization";
import {
  createEmptyProfileMemoryState,
  PROFILE_MEMORY_SCHEMA_VERSION
} from "./profileMemoryState";

/**
 * Coerces a timestamp candidate to valid ISO format, falling back to `now`.
 *
 * @param value - Candidate timestamp from persisted or inbound payloads.
 * @returns Valid ISO timestamp string.
 */
export function safeIsoOrNow(value: string | undefined): string {
  if (typeof value !== "string") {
    return new Date().toISOString();
  }

  const parsed = Date.parse(value.trim());
  if (!Number.isFinite(parsed)) {
    return new Date().toISOString();
  }

  return new Date(parsed).toISOString();
}

/**
 * Coerces one required retained fact timestamp to canonical ISO with a deterministic fallback.
 *
 * @param value - Persisted timestamp candidate.
 * @param fallback - Deterministic fallback timestamp.
 * @returns Canonical ISO timestamp.
 */
function safeIsoOrFallback(value: unknown, fallback: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return Number.isFinite(Date.parse(trimmed))
    ? new Date(Date.parse(trimmed)).toISOString()
    : fallback;
}

/**
 * Coerces one optional retained fact lifecycle timestamp to canonical ISO or clears it.
 *
 * @param value - Persisted optional timestamp candidate.
 * @returns Canonical ISO timestamp or `null`.
 */
function normalizeOptionalIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return Number.isFinite(Date.parse(trimmed))
    ? new Date(Date.parse(trimmed)).toISOString()
    : null;
}

/**
 * Normalizes unknown persisted payloads into a valid `ProfileMemoryState`.
 *
 * @param raw - Parsed JSON candidate from storage.
 * @returns Canonical profile state with filtered/normalized facts.
 */
export function normalizeProfileMemoryState(raw: unknown): ProfileMemoryState {
  const empty = createEmptyProfileMemoryState();
  if (!raw || typeof raw !== "object") {
    return empty;
  }

  const candidate = raw as Partial<ProfileMemoryState>;
  const updatedAt = safeIsoOrNow(candidate.updatedAt);
  const facts = Array.isArray(candidate.facts)
    ? candidate.facts.flatMap((fact): ProfileFactRecord[] => {
      if (!fact || typeof fact !== "object") {
        return [];
      }
      const typedFact = fact as ProfileFactRecord;
      const normalizedFactId = normalizeRetainedFactId(typedFact.id);
      const normalizedFactKey = normalizeRetainedFactKey(typedFact.key);
      const normalizedFactValue = normalizeRetainedFactValue(typedFact.value);
      const normalizedFactSourceTaskId = normalizeRetainedFactSourceTaskId(
        typedFact.sourceTaskId
      );
      const normalizedFactSource = normalizeRetainedFactSource(typedFact.source);
      const normalizedStatus = normalizeRetainedFactStatus(typedFact.status);
      const mutationAudit = normalizeProfileMutationAuditMetadata(typedFact.mutationAudit);
      if (
        normalizedFactId === null ||
        normalizedFactKey === null ||
        normalizedFactValue === null ||
        normalizedFactSourceTaskId === null ||
        normalizedFactSource === null ||
        typeof typedFact.sensitive !== "boolean" ||
        normalizedStatus === null ||
        typeof typedFact.observedAt !== "string" ||
        typeof typedFact.lastUpdatedAt !== "string"
      ) {
        return [];
      }
      if (!isRetainedFactSupportedByTruthGovernance(
        typedFact,
        normalizedFactKey,
        normalizedFactValue,
        normalizedFactSourceTaskId,
        normalizedFactSource,
        mutationAudit
      )) {
        return [];
      }

      return [normalizeProfileFactRecord(
        typedFact,
        updatedAt,
        mutationAudit,
        normalizedFactId,
        normalizedFactKey,
        normalizedFactValue,
        normalizedFactSourceTaskId,
        normalizedFactSource,
        normalizedStatus
      )];
    })
    : [];
  const dedupedFacts = repairNormalizedRetainedMixedPolicyConflictFacts(
    repairNormalizedRetainedPreserveConflictFacts(
      repairNormalizedRetainedReplaceConflictFacts(
        repairNormalizedRetainedSemanticDuplicateFacts(
          dedupeNormalizedRetainedFacts(facts)
        )
      )
    )
  );
  const episodes = normalizeProfileMemoryEpisodes((candidate as { episodes?: unknown }).episodes);
  const ingestReceipts = normalizeProfileMemoryIngestReceipts(
    (candidate as { ingestReceipts?: unknown }).ingestReceipts,
    updatedAt
  );

  return {
    schemaVersion: PROFILE_MEMORY_SCHEMA_VERSION,
    updatedAt,
    facts: dedupedFacts,
    episodes,
    ingestReceipts,
    graph: normalizeProfileMemoryGraphState(
      (candidate as { graph?: unknown }).graph,
      updatedAt,
      episodes,
      dedupedFacts
    )
  };
}

/**
 * Normalizes one retained fact record into a stable timestamp-safe shape for compatibility and
 * graph-backed repair surfaces.
 *
 * @param fact - Persisted fact candidate that already passed type checks.
 * @param updatedAt - Canonical outer state normalization timestamp.
 * @param mutationAudit - Normalized optional mutation-audit metadata.
 * @param normalizedFactId - Canonical retained fact id.
 * @param normalizedFactKey - Canonical retained fact key.
 * @param normalizedFactValue - Canonical retained fact value.
 * @param normalizedFactSourceTaskId - Canonical retained fact source-task id.
 * @param normalizedFactSource - Canonical retained fact source.
 * @param normalizedStatus - Canonical retained fact status.
 * @returns Stable fact record with repaired lifecycle timestamps.
 */
function normalizeProfileFactRecord(
  fact: ProfileFactRecord,
  updatedAt: string,
  mutationAudit: ProfileMutationAuditMetadataV1 | null,
  normalizedFactId: string,
  normalizedFactKey: string,
  normalizedFactValue: string,
  normalizedFactSourceTaskId: string,
  normalizedFactSource: string,
  normalizedStatus: ProfileFactRecord["status"]
): ProfileFactRecord {
  const confidence = normalizeRetainedFactConfidence(fact.confidence);
  const lastUpdatedAt = safeIsoOrFallback(fact.lastUpdatedAt, updatedAt);
  const observedAt = safeIsoOrFallback(fact.observedAt, lastUpdatedAt);
  const confirmedAt = normalizeOptionalIsoTimestamp(fact.confirmedAt);
  const supersededAt = normalizeOptionalIsoTimestamp(fact.supersededAt);
  const sensitive = isStoredProfileFactEffectivelySensitive({
    key: normalizedFactKey,
    value: normalizedFactValue,
    sensitive: fact.sensitive
  });
  return {
    ...fact,
    id: normalizedFactId,
    key: normalizedFactKey,
    value: normalizedFactValue,
    sensitive,
    status: normalizedStatus,
    confidence,
    sourceTaskId: normalizedFactSourceTaskId,
    source: normalizedFactSource,
    observedAt,
    confirmedAt: confirmedAt ?? (normalizedStatus === "confirmed" ? lastUpdatedAt : null),
    supersededAt: normalizedStatus === "superseded" ? supersededAt ?? lastUpdatedAt : null,
    lastUpdatedAt,
    mutationAudit: mutationAudit ?? undefined
  };
}

/**
 * Normalizes persisted ingest-receipt ledgers into a stable bounded shape.
 *
 * @param raw - Unknown receipt payload from storage.
 * @returns Stable bounded ingest receipts.
 */
function normalizeProfileMemoryIngestReceipts(
  raw: unknown,
  normalizationTimestamp: string
): ProfileMemoryIngestReceiptRecord[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const normalizedReceipts = raw.flatMap((receipt): ProfileMemoryIngestReceiptRecord[] => {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
      return [];
    }
    const candidate = receipt as Partial<ProfileMemoryIngestReceiptRecord>;
    const normalizedTurnIdCandidate =
      typeof candidate.turnId === "string" ? candidate.turnId.trim() : null;
    const normalizedSourceFingerprintCandidate =
      typeof candidate.sourceFingerprint === "string"
        ? candidate.sourceFingerprint.trim()
        : null;
    const receiptKey =
      buildRetainedProfileMemoryIngestReceiptKey(
        normalizedTurnIdCandidate,
        normalizedSourceFingerprintCandidate
      ) ?? normalizeCanonicalRetainedReceiptKey(candidate.receiptKey);
    if (!receiptKey) {
      return [];
    }
    const turnId = normalizeRecoveredReceiptTurnId(candidate.turnId, receiptKey);
    const sourceFingerprint = normalizeRecoveredReceiptSourceFingerprint(
      candidate.sourceFingerprint,
      receiptKey
    );
    const sourceTaskId = normalizeRecoveredReceiptSourceTaskId(
      candidate.sourceTaskId,
      receiptKey
    );
    return [{
      receiptKey,
      turnId,
      sourceFingerprint,
      sourceTaskId,
      recordedAt: safeIsoOrFallback(candidate.recordedAt, normalizationTimestamp)
    }];
  });
  const dedupedReceipts = new Map<string, ProfileMemoryIngestReceiptRecord>();
  for (const receipt of normalizedReceipts) {
    const existing = dedupedReceipts.get(receipt.receiptKey);
    if (!existing || shouldReplaceNormalizedProfileMemoryIngestReceipt(existing, receipt)) {
      dedupedReceipts.set(receipt.receiptKey, receipt);
    }
  }
  return [...dedupedReceipts.values()]
    .sort(compareNormalizedProfileMemoryIngestReceiptOrder)
    .slice(-MAX_PROFILE_MEMORY_INGEST_RECEIPTS)
    .map((entry) => entry);
}

/**
 * Rebuilds one retained ingest receipt key only from stable non-recovered provenance fields.
 *
 * **Why it exists:**
 * Retained receipt normalization should only rebuild canonical receipt keys from bounded
 * provenance that still reflects the original request path, not from deterministic recovery
 * markers that exist only to preserve otherwise valid retained receipts after malformed reloads.
 *
 * **What it talks to:**
 * - Uses `buildProfileMemoryIngestReceiptKey` (import) from `./profileMemoryIngestIdempotency`.
 * - Uses `isRecoveredReceiptSourceFingerprint` (import) from
 *   `./profileMemoryIngestReceiptNormalizationSupport`.
 * - Uses `isRecoveredReceiptTurnId` (import) from
 *   `./profileMemoryIngestReceiptNormalizationSupport`.
 *
 * @param turnId - Trimmed retained turn id candidate.
 * @param sourceFingerprint - Trimmed retained source fingerprint candidate.
 * @returns Canonical rebuilt receipt key, or `null` when retained provenance is too weak.
 */
function buildRetainedProfileMemoryIngestReceiptKey(
  turnId: string | null,
  sourceFingerprint: string | null
): string | null {
  if (
    !turnId ||
    turnId.length === 0 ||
    isRecoveredReceiptTurnId(turnId) ||
    !sourceFingerprint ||
    sourceFingerprint.length === 0 ||
    isRecoveredReceiptSourceFingerprint(sourceFingerprint)
  ) {
    return null;
  }
  return buildProfileMemoryIngestReceiptKey({
    sourceSurface: "broker_task_ingest",
    turnId,
    sourceFingerprint
  });
}

/**
 * Normalizes profile mutation audit metadata into a stable shape.
 *
 * @param raw - Unknown audit metadata payload.
 * @returns Normalized audit metadata, or `null` when invalid.
 */
function normalizeProfileMutationAuditMetadata(
  raw: unknown
): ProfileMutationAuditMetadataV1 | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const candidate = raw as Partial<ProfileMutationAuditMetadataV1>;
  const classifier =
    typeof candidate.classifier === "string"
      ? candidate.classifier.trim().toLowerCase()
      : null;
  if (classifier !== "commitment_signal") {
    return null;
  }
  const category =
    typeof candidate.category === "string" ? candidate.category.trim().toUpperCase() : null;
  if (
    category !== "TOPIC_RESOLUTION_CANDIDATE" &&
    category !== "GENERIC_RESOLUTION" &&
    category !== "RESOLVED_MARKER" &&
    category !== "NO_SIGNAL" &&
    category !== "UNCLEAR"
  ) {
    return null;
  }
  const confidenceTier =
    typeof candidate.confidenceTier === "string"
      ? candidate.confidenceTier.trim().toUpperCase()
      : null;
  if (
    confidenceTier !== "HIGH" &&
    confidenceTier !== "MED" &&
    confidenceTier !== "LOW"
  ) {
    return null;
  }
  if (
    typeof candidate.matchedRuleId !== "string" ||
    typeof candidate.rulepackVersion !== "string" ||
    typeof candidate.conflict !== "boolean"
  ) {
    return null;
  }
  const matchedRuleId = candidate.matchedRuleId.trim();
  const rulepackVersion = candidate.rulepackVersion.trim();
  if (matchedRuleId.length === 0 || rulepackVersion.length === 0) {
    return null;
  }

  return {
    classifier,
    category,
    confidenceTier,
    matchedRuleId,
    rulepackVersion,
    conflict: candidate.conflict
  };
}
