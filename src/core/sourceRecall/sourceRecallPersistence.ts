/**
 * @fileoverview Persistence normalization helpers for Source Recall store documents.
 */

import {
  buildSourceRecallAuthorityFlags,
  normalizeSourceRecallAuthority,
  normalizeSourceRecallCaptureClass,
  normalizeSourceRecallFreshness,
  normalizeSourceRecallLifecycleState,
  normalizeSourceRecallSourceAuthority,
  normalizeSourceRecallSourceKind,
  normalizeSourceRecallSourceRole,
  normalizeSourceRecallSourceTimeKind,
  type SourceRecallChunk,
  type SourceRecallLifecycleState,
  type SourceRecallOriginRef,
  type SourceRecallRecord
} from "./contracts";

export interface SourceRecallDocument {
  schemaVersion: "v1";
  updatedAt: string;
  records: SourceRecallRecord[];
  chunks: SourceRecallChunk[];
}

/**
 * Creates the empty Source Recall document used before the store has records.
 *
 * **Why it exists:**
 * Store bootstrap and malformed persistence recovery need one zero-value document shape so Source
 * Recall does not create ad hoc defaults in multiple modules.
 *
 * **What it talks to:**
 * - Uses local type contracts within this module.
 *
 * @returns Empty Source Recall document.
 */
export function createEmptySourceRecallDocument(): SourceRecallDocument {
  return {
    schemaVersion: "v1",
    updatedAt: new Date().toISOString(),
    records: [],
    chunks: []
  };
}

/**
 * Parses unknown persisted payload into a Source Recall document.
 *
 * **Why it exists:**
 * Source Recall records are sensitive evidence. Bad persisted rows should be ignored or
 * quarantined instead of gaining authority through loose object casting.
 *
 * **What it talks to:**
 * - Uses local normalization helpers within this module.
 *
 * @param input - Unknown persisted Source Recall document.
 * @returns Normalized Source Recall document.
 */
export function parseSourceRecallDocument(input: unknown): SourceRecallDocument {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return createEmptySourceRecallDocument();
  }
  const candidate = input as Partial<SourceRecallDocument>;
  return {
    schemaVersion: "v1",
    updatedAt:
      typeof candidate.updatedAt === "string" && candidate.updatedAt.trim().length > 0
        ? candidate.updatedAt
        : new Date().toISOString(),
    records: Array.isArray(candidate.records)
      ? candidate.records
          .map((record) => parseSourceRecallRecord(record))
          .filter((record): record is SourceRecallRecord => record !== null)
          .sort(compareSourceRecallRecords)
      : [],
    chunks: Array.isArray(candidate.chunks)
      ? candidate.chunks
          .map((chunk) => parseSourceRecallChunk(chunk))
          .filter((chunk): chunk is SourceRecallChunk => chunk !== null)
          .sort(compareSourceRecallChunks)
      : []
  };
}

/**
 * Normalizes a Source Recall record before persistence.
 *
 * **Why it exists:**
 * The store accepts manually constructed S1 test records. This helper keeps record fields closed
 * and deterministic before they are written.
 *
 * **What it talks to:**
 * - Uses local normalization helpers within this module.
 *
 * @param input - Candidate Source Recall record.
 * @returns Normalized Source Recall record.
 */
export function normalizeSourceRecallRecord(input: SourceRecallRecord): SourceRecallRecord {
  return {
    sourceRecordId: input.sourceRecordId.trim(),
    scopeId: input.scopeId.trim(),
    threadId: input.threadId.trim(),
    sourceKind: normalizeSourceRecallSourceKind(input.sourceKind),
    sourceRole: normalizeSourceRecallSourceRole(input.sourceRole),
    sourceAuthority: normalizeSourceRecallSourceAuthority(input.sourceAuthority),
    captureClass: normalizeSourceRecallCaptureClass(input.captureClass),
    recallAuthority: normalizeSourceRecallAuthority(input.recallAuthority),
    lifecycleState: normalizeSourceRecallLifecycleState(input.lifecycleState),
    originRef: normalizeSourceRecallOriginRef(input.originRef),
    sourceRecordHash: input.sourceRecordHash.trim(),
    observedAt: input.observedAt,
    capturedAt: input.capturedAt,
    sourceTimeKind: normalizeSourceRecallSourceTimeKind(input.sourceTimeKind),
    freshness: normalizeSourceRecallFreshness(input.freshness),
    sensitive: input.sensitive === true
  };
}

/**
 * Normalizes a Source Recall chunk before persistence.
 *
 * **Why it exists:**
 * S1 keeps storage test-only, but chunks still need the same fail-closed authority flags as later
 * production storage.
 *
 * **What it talks to:**
 * - Uses `buildSourceRecallAuthorityFlags` from `./contracts`.
 *
 * @param input - Candidate Source Recall chunk.
 * @returns Normalized Source Recall chunk.
 */
export function normalizeSourceRecallChunk(input: SourceRecallChunk): SourceRecallChunk {
  return {
    chunkId: input.chunkId.trim(),
    sourceRecordId: input.sourceRecordId.trim(),
    chunkIndex: Number.isFinite(input.chunkIndex) ? Math.max(0, Math.floor(input.chunkIndex)) : 0,
    text: input.text,
    chunkHash: input.chunkHash.trim(),
    lifecycleState: normalizeSourceRecallLifecycleState(input.lifecycleState),
    recallAuthority: normalizeSourceRecallAuthority(input.recallAuthority),
    authority: buildSourceRecallAuthorityFlags(input.authority.plannerAuthority)
  };
}

/**
 * Builds the next document after one record/chunk upsert.
 *
 * **Why it exists:**
 * Upsert semantics need to be deterministic for retries and tests before later capture code adds
 * idempotency around origin refs and hashes.
 *
 * **What it talks to:**
 * - Uses local normalization and sorting helpers within this module.
 *
 * @param document - Existing Source Recall document.
 * @param record - Record to insert or replace.
 * @param chunks - Chunks to replace for the record.
 * @returns Updated Source Recall document.
 */
export function upsertSourceRecallRecordInDocument(
  document: SourceRecallDocument,
  record: SourceRecallRecord,
  chunks: readonly SourceRecallChunk[]
): SourceRecallDocument {
  const normalizedRecord = normalizeSourceRecallRecord(record);
  const normalizedChunks = chunks
    .map((chunk) => normalizeSourceRecallChunk({ ...chunk, sourceRecordId: normalizedRecord.sourceRecordId }))
    .sort(compareSourceRecallChunks);
  const retainedRecords = document.records.filter(
    (existing) => existing.sourceRecordId !== normalizedRecord.sourceRecordId
  );
  const retainedChunks = document.chunks.filter(
    (existing) => existing.sourceRecordId !== normalizedRecord.sourceRecordId
  );
  return {
    schemaVersion: "v1",
    updatedAt: new Date().toISOString(),
    records: [...retainedRecords, normalizedRecord].sort(compareSourceRecallRecords),
    chunks: [...retainedChunks, ...normalizedChunks].sort(compareSourceRecallChunks)
  };
}

/**
 * Marks one source record and its chunks as forgotten in a document.
 *
 * **Why it exists:**
 * S1 needs delete-marker behavior before S2 adds the full retention and cascade policy.
 *
 * **What it talks to:**
 * - Uses local sorting helpers within this module.
 *
 * @param document - Existing Source Recall document.
 * @param sourceRecordId - Source record to mark forgotten.
 * @returns Updated document with forgotten lifecycle markers.
 */
export function markSourceRecallRecordForgottenInDocument(
  document: SourceRecallDocument,
  sourceRecordId: string
): SourceRecallDocument {
  return markSourceRecallRecordsLifecycleInDocument(
    document,
    (record) => record.sourceRecordId === sourceRecordId,
    "forgotten"
  );
}

/**
 * Marks source records linked to one origin parent reference with a lifecycle state.
 *
 * **Why it exists:**
 * Media artifact deletion/redaction should hide linked Source Recall chunks without touching
 * unrelated records or owned asset bytes.
 *
 * **What it talks to:**
 * - Uses local lifecycle mutation helper within this module.
 *
 * @param document - Existing Source Recall document.
 * @param parentRefId - Origin parent reference, usually media artifact id or checksum.
 * @param lifecycleState - Lifecycle state to apply.
 * @returns Updated document.
 */
export function markSourceRecallRecordsByOriginParentRefInDocument(
  document: SourceRecallDocument,
  parentRefId: string,
  lifecycleState: Extract<SourceRecallLifecycleState, "redacted" | "forgotten" | "expired" | "quarantined">
): SourceRecallDocument {
  const normalizedParentRefId = parentRefId.trim();
  if (!normalizedParentRefId) {
    return document;
  }
  return markSourceRecallRecordsLifecycleInDocument(
    document,
    (record) => record.originRef.parentRefId === normalizedParentRefId,
    lifecycleState
  );
}

/**
 * Applies a lifecycle state to every record matching a predicate and to the record's chunks.
 *
 * @param document - Existing Source Recall document.
 * @param matches - Record predicate.
 * @param lifecycleState - Lifecycle state to apply.
 * @returns Updated document.
 */
function markSourceRecallRecordsLifecycleInDocument(
  document: SourceRecallDocument,
  matches: (record: SourceRecallRecord) => boolean,
  lifecycleState: SourceRecallLifecycleState
): SourceRecallDocument {
  const matchedRecordIds = new Set(
    document.records
      .filter(matches)
      .map((record) => record.sourceRecordId)
  );
  return {
    schemaVersion: "v1",
    updatedAt: new Date().toISOString(),
    records: document.records
      .map((record) =>
        matchedRecordIds.has(record.sourceRecordId)
          ? { ...record, lifecycleState }
          : record
      )
      .sort(compareSourceRecallRecords),
    chunks: document.chunks
      .map((chunk) =>
        matchedRecordIds.has(chunk.sourceRecordId)
          ? { ...chunk, lifecycleState }
          : chunk
      )
      .sort(compareSourceRecallChunks)
  };
}

/**
 * Returns whether one lifecycle state is visible to normal S1 reads.
 *
 * **Why it exists:**
 * S1 must prove delete markers prevent forgotten chunks from returning before broader retention
 * and projection policy exists.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param lifecycleState - Source Recall lifecycle state.
 * @returns `true` when the record/chunk is visible to normal reads.
 */
export function isSourceRecallLifecycleVisible(lifecycleState: SourceRecallRecord["lifecycleState"]): boolean {
  return lifecycleState === "active";
}

/**
 * Parses one Source Recall record from persisted input.
 *
 * **Why it exists:**
 * Record parsing rejects malformed id/hash fields while normalizing closed vocabulary fields.
 *
 * **What it talks to:**
 * - Uses local normalization helpers within this module.
 *
 * @param input - Unknown persisted record.
 * @returns Normalized record, or `null` when required identifiers are missing.
 */
function parseSourceRecallRecord(input: unknown): SourceRecallRecord | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const candidate = input as Partial<SourceRecallRecord>;
  if (
    typeof candidate.sourceRecordId !== "string" ||
    typeof candidate.scopeId !== "string" ||
    typeof candidate.threadId !== "string" ||
    typeof candidate.sourceRecordHash !== "string" ||
    typeof candidate.observedAt !== "string" ||
    typeof candidate.capturedAt !== "string"
  ) {
    return null;
  }
  return normalizeSourceRecallRecord({
    sourceRecordId: candidate.sourceRecordId,
    scopeId: candidate.scopeId,
    threadId: candidate.threadId,
    sourceKind: candidate.sourceKind ?? "unknown",
    sourceRole: candidate.sourceRole ?? "unknown",
    sourceAuthority: candidate.sourceAuthority ?? "unknown",
    captureClass: candidate.captureClass ?? "excluded_by_default",
    recallAuthority: candidate.recallAuthority ?? "quoted_evidence_only",
    lifecycleState: candidate.lifecycleState ?? "quarantined",
    originRef: candidate.originRef ?? { surface: "unknown", refId: candidate.sourceRecordId },
    sourceRecordHash: candidate.sourceRecordHash,
    observedAt: candidate.observedAt,
    capturedAt: candidate.capturedAt,
    sourceTimeKind: candidate.sourceTimeKind ?? "unknown",
    freshness: candidate.freshness ?? "unknown",
    sensitive: candidate.sensitive === true
  });
}

/**
 * Parses one Source Recall chunk from persisted input.
 *
 * **Why it exists:**
 * Chunk parsing keeps raw text test-only while ensuring malformed lifecycle or authority metadata
 * cannot become visible storage state.
 *
 * **What it talks to:**
 * - Uses local normalization helpers within this module.
 *
 * @param input - Unknown persisted chunk.
 * @returns Normalized chunk, or `null` when required identifiers are missing.
 */
function parseSourceRecallChunk(input: unknown): SourceRecallChunk | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const candidate = input as Partial<SourceRecallChunk>;
  if (
    typeof candidate.chunkId !== "string" ||
    typeof candidate.sourceRecordId !== "string" ||
    typeof candidate.text !== "string" ||
    typeof candidate.chunkHash !== "string"
  ) {
    return null;
  }
  return normalizeSourceRecallChunk({
    chunkId: candidate.chunkId,
    sourceRecordId: candidate.sourceRecordId,
    chunkIndex: typeof candidate.chunkIndex === "number" ? candidate.chunkIndex : 0,
    text: candidate.text,
    chunkHash: candidate.chunkHash,
    lifecycleState: candidate.lifecycleState ?? "quarantined",
    recallAuthority: candidate.recallAuthority ?? "quoted_evidence_only",
    authority: candidate.authority ?? buildSourceRecallAuthorityFlags()
  });
}

/**
 * Normalizes the origin reference stored with a source record.
 *
 * **Why it exists:**
 * Origin refs identify source lineage but must remain metadata, not raw source text or permission.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param input - Candidate origin reference.
 * @returns Normalized origin reference.
 */
function normalizeSourceRecallOriginRef(input: SourceRecallOriginRef): SourceRecallOriginRef {
  return {
    surface: input.surface.trim() || "unknown",
    refId: input.refId.trim() || "unknown",
    parentRefId: input.parentRefId?.trim() || undefined
  };
}

/**
 * Orders records deterministically for persistence and tests.
 *
 * **Why it exists:**
 * Stable persistence output keeps store tests deterministic and prevents incidental ordering churn.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param left - Left record.
 * @param right - Right record.
 * @returns Sort order.
 */
function compareSourceRecallRecords(left: SourceRecallRecord, right: SourceRecallRecord): number {
  if (left.scopeId !== right.scopeId) {
    return left.scopeId.localeCompare(right.scopeId);
  }
  if (left.threadId !== right.threadId) {
    return left.threadId.localeCompare(right.threadId);
  }
  return left.sourceRecordId.localeCompare(right.sourceRecordId);
}

/**
 * Orders chunks deterministically for persistence and tests.
 *
 * **Why it exists:**
 * Chunk order should be stable by source record and chunk index, regardless of insertion order.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param left - Left chunk.
 * @param right - Right chunk.
 * @returns Sort order.
 */
function compareSourceRecallChunks(left: SourceRecallChunk, right: SourceRecallChunk): number {
  if (left.sourceRecordId !== right.sourceRecordId) {
    return left.sourceRecordId.localeCompare(right.sourceRecordId);
  }
  if (left.chunkIndex !== right.chunkIndex) {
    return left.chunkIndex - right.chunkIndex;
  }
  return left.chunkId.localeCompare(right.chunkId);
}
