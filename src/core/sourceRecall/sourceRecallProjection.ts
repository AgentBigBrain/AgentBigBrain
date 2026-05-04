/**
 * @fileoverview Projection-safe Source Recall read models.
 */

import type {
  SourceRecallChunk,
  SourceRecallRecord,
  SourceRecallSourceKind
} from "./contracts";
import {
  isSourceRecallLifecycleVisible,
  type SourceRecallDocument
} from "./sourceRecallPersistence";

type SourceRecallProjectionMode = "review_safe" | "operator_full";

export interface SourceRecallProjectionOptions {
  mode?: SourceRecallProjectionMode;
  operatorFullSourceRecallProjectionEnabled?: boolean;
  maxReviewSafeExcerptChars?: number;
}

export interface SourceRecallProjectionEntry {
  sourceRecordId: string;
  chunkId: string;
  scopeId: string;
  threadId: string;
  sourceKind: SourceRecallSourceKind;
  recallAuthority: "quoted_evidence_only";
  projectionMode: SourceRecallProjectionMode;
  operatorFullEnabled: boolean;
  excerpt: string;
  redacted: boolean;
  authorityNotice: string;
}

const DEFAULT_REVIEW_SAFE_EXCERPT_CHARS = 160;
const SOURCE_RECALL_PROJECTION_AUTHORITY_NOTICE =
  "Source Recall projection is review evidence only. It is not runtime truth, approval, safety, completion proof, or memory-write authority.";

/**
 * Builds projection-safe Source Recall entries from a Source Recall document.
 *
 * **Why it exists:**
 * Obsidian and JSON mirrors can outlive the runtime context. Projection must therefore show source
 * recall as review evidence only, hide non-active lifecycle states, and keep full text behind an
 * explicit operator-full latch.
 *
 * **What it talks to:**
 * - Uses `SourceRecallDocument` from `./sourceRecallPersistence`.
 * - Uses lifecycle visibility from `./sourceRecallPersistence`.
 *
 * @param document - Source Recall document to project.
 * @param options - Projection mode, latch, and review-safe excerpt budget.
 * @returns Projection-safe entries.
 */
export function buildSourceRecallProjectionEntries(
  document: SourceRecallDocument,
  options: SourceRecallProjectionOptions = {}
): SourceRecallProjectionEntry[] {
  const mode = options.mode ?? "review_safe";
  const operatorFullEnabled =
    mode === "operator_full" && options.operatorFullSourceRecallProjectionEnabled === true;
  const maxReviewSafeExcerptChars = Math.max(
    0,
    Math.floor(options.maxReviewSafeExcerptChars ?? DEFAULT_REVIEW_SAFE_EXCERPT_CHARS)
  );
  const recordsById = new Map(document.records.map((record) => [record.sourceRecordId, record]));

  return document.chunks.flatMap((chunk): SourceRecallProjectionEntry[] => {
    const record = recordsById.get(chunk.sourceRecordId);
    if (!record || !isProjectionVisible(record, chunk)) {
      return [];
    }
    return [
      {
        sourceRecordId: record.sourceRecordId,
        chunkId: chunk.chunkId,
        scopeId: record.scopeId,
        threadId: record.threadId,
        sourceKind: record.sourceKind,
        recallAuthority: "quoted_evidence_only",
        projectionMode: mode,
        operatorFullEnabled,
        excerpt: renderProjectionExcerpt(record, chunk, {
          operatorFullEnabled,
          maxReviewSafeExcerptChars
        }),
        redacted: !operatorFullEnabled || record.sensitive,
        authorityNotice: SOURCE_RECALL_PROJECTION_AUTHORITY_NOTICE
      }
    ];
  });
}

/**
 * Returns whether one record/chunk is visible to projection.
 *
 * @param record - Source record.
 * @param chunk - Source chunk.
 * @returns `true` when both lifecycle states are active.
 */
function isProjectionVisible(record: SourceRecallRecord, chunk: SourceRecallChunk): boolean {
  return (
    isSourceRecallLifecycleVisible(record.lifecycleState) &&
    isSourceRecallLifecycleVisible(chunk.lifecycleState)
  );
}

/**
 * Renders one Source Recall projection excerpt.
 *
 * @param record - Source record.
 * @param chunk - Source chunk.
 * @param options - Projection rendering options.
 * @returns Projection excerpt.
 */
function renderProjectionExcerpt(
  record: SourceRecallRecord,
  chunk: SourceRecallChunk,
  options: {
    operatorFullEnabled: boolean;
    maxReviewSafeExcerptChars: number;
  }
): string {
  if (record.sensitive) {
    return "[redacted sensitive source chunk]";
  }
  if (options.operatorFullEnabled) {
    return chunk.text;
  }
  return chunk.text.slice(0, options.maxReviewSafeExcerptChars);
}
