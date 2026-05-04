/**
 * @fileoverview Exact Source Recall retrieval with bounded audit metadata.
 */

import { hashSha256 } from "../cryptoUtils";
import {
  buildSourceRecallAuthorityFlags,
  SOURCE_RECALL_SOURCE_KIND_VALUES,
  type SourceRecallBundle,
  type SourceRecallChunk,
  type SourceRecallExcerpt,
  type SourceRecallOutputBudget,
  type SourceRecallRankingEvidence,
  type SourceRecallRecord,
  type SourceRecallRetrievalAuthority,
  type SourceRecallRetrievalMode,
  type SourceRecallSourceKind
} from "./contracts";
import { isSourceRecallLifecycleVisible } from "./sourceRecallPersistence";
import type { SourceRecallStore } from "./sourceRecallStore";

export const DEFAULT_SOURCE_RECALL_OUTPUT_BUDGET: SourceRecallOutputBudget = {
  maxRecords: 5,
  maxChunks: 10,
  maxExcerptCharsPerChunk: 600,
  maxTotalExcerptChars: 3000,
  sourceKindAllowlist: SOURCE_RECALL_SOURCE_KIND_VALUES.filter(
    (kind) => kind !== "unknown"
  ),
  sensitivityRedactionPolicy: "redact_sensitive"
};

export interface SourceRecallRetrievalQuery {
  scopeId?: string;
  threadId?: string;
  sourceRecordId?: string;
  chunkId?: string;
  exactQuote?: string;
  sourceKinds?: readonly SourceRecallSourceKind[];
  keywords?: readonly string[];
  semanticVectorChunkIds?: readonly string[];
}

export interface SourceRecallRetrievalAuditEvent {
  queryHash: string;
  scopeId: string | null;
  threadId: string | null;
  retrievalMode: SourceRecallRetrievalMode;
  returnedSourceRecordIds: readonly string[];
  returnedChunkIds: readonly string[];
  totalExcerptsReturned: number;
  totalCharsReturned: number;
  blockedRedactedCount: number;
}

export interface SourceRecallRetrievalResult {
  bundle: SourceRecallBundle;
  auditEvent: SourceRecallRetrievalAuditEvent;
}

interface CandidateChunk {
  record: SourceRecallRecord;
  chunk: SourceRecallChunk;
  ranking: SourceRecallRankingEvidence;
}

/**
 * Retrieves Source Recall by exact source refs or exact quoted text.
 *
 * **Why it exists:**
 * S5A needs one retrieval path that can prove exact recall while preserving output budgets,
 * lifecycle filtering, sensitivity policy, and bounded audit events before context injection exists.
 *
 * **What it talks to:**
 * - Uses `SourceRecallStore.loadDocument`.
 * - Uses `isSourceRecallLifecycleVisible` from `./sourceRecallPersistence`.
 *
 * @param store - Source Recall store.
 * @param query - Exact source, chunk, quote, scope, thread, and source-kind filters.
 * @param budget - Optional output budget override.
 * @returns Recall bundle plus bounded audit event.
 */
export async function retrieveSourceRecall(
  store: Pick<SourceRecallStore, "loadDocument">,
  query: SourceRecallRetrievalQuery,
  budget: SourceRecallOutputBudget = DEFAULT_SOURCE_RECALL_OUTPUT_BUDGET
): Promise<SourceRecallRetrievalResult> {
  const document = await store.loadDocument();
  const retrievalMode = resolveRetrievalMode(query);
  const retrievalAuthority = resolveRetrievalAuthority(query);
  const normalizedBudget = normalizeSourceRecallOutputBudget(budget);
  let blockedRedactedCount = 0;

  const recordsById = new Map(document.records.map((record) => [record.sourceRecordId, record]));
  const candidates: CandidateChunk[] = [];
  for (const chunk of document.chunks) {
    const record = recordsById.get(chunk.sourceRecordId);
    if (!record) {
      blockedRedactedCount += 1;
      continue;
    }
    if (!isRecordAndChunkVisible(record, chunk)) {
      blockedRedactedCount += 1;
      continue;
    }
    if (!matchesRecordQuery(record, query, normalizedBudget)) {
      continue;
    }
    if (query.chunkId && chunk.chunkId !== query.chunkId) {
      continue;
    }
    if (query.exactQuote && !chunk.text.includes(query.exactQuote)) {
      continue;
    }
    const ranking = scoreCandidate(record, chunk, query, retrievalMode, retrievalAuthority);
    if (!ranking) {
      continue;
    }
    candidates.push({ record, chunk, ranking });
  }
  candidates.sort(compareCandidates);

  const excerpts: SourceRecallExcerpt[] = [];
  const includedRecordIds = new Set<string>();
  let totalCharsReturned = 0;
  for (const candidate of candidates) {
    if (!includedRecordIds.has(candidate.record.sourceRecordId)) {
      if (includedRecordIds.size >= normalizedBudget.maxRecords) {
        blockedRedactedCount += 1;
        continue;
      }
      includedRecordIds.add(candidate.record.sourceRecordId);
    }
    if (excerpts.length >= normalizedBudget.maxChunks) {
      blockedRedactedCount += 1;
      continue;
    }
    if (
      candidate.record.sensitive &&
      normalizedBudget.sensitivityRedactionPolicy === "exclude_sensitive"
    ) {
      blockedRedactedCount += 1;
      continue;
    }
    const excerpt = buildBudgetedExcerpt(candidate, query.exactQuote ?? null, normalizedBudget);
    const remainingTotalBudget = normalizedBudget.maxTotalExcerptChars - totalCharsReturned;
    if (remainingTotalBudget <= 0) {
      blockedRedactedCount += 1;
      continue;
    }
    const boundedExcerpt =
      excerpt.excerpt.length <= remainingTotalBudget
        ? excerpt
        : {
            ...excerpt,
            excerpt: excerpt.excerpt.slice(0, remainingTotalBudget)
          };
    totalCharsReturned += boundedExcerpt.excerpt.length;
    excerpts.push(boundedExcerpt);
  }

  const returnedSourceRecordIds = [...new Set(excerpts.map((excerpt) => excerpt.sourceRecordId))];
  const returnedChunkIds = excerpts.map((excerpt) => excerpt.chunkId);
  return {
    bundle: {
      scopeId: query.scopeId ?? "",
      threadId: query.threadId ?? "",
      retrievalMode,
      retrievalAuthority,
      budget: normalizedBudget,
      excerpts,
      authority: buildSourceRecallAuthorityFlags()
    },
    auditEvent: {
      queryHash: buildSourceRecallQueryHash(query),
      scopeId: query.scopeId ?? null,
      threadId: query.threadId ?? null,
      retrievalMode,
      returnedSourceRecordIds,
      returnedChunkIds,
      totalExcerptsReturned: excerpts.length,
      totalCharsReturned,
      blockedRedactedCount
    }
  };
}

/**
 * Normalizes output budget values to safe positive bounds.
 *
 * @param budget - Candidate output budget.
 * @returns Normalized budget.
 */
export function normalizeSourceRecallOutputBudget(
  budget: SourceRecallOutputBudget
): SourceRecallOutputBudget {
  return {
    maxRecords: Math.max(0, Math.floor(budget.maxRecords)),
    maxChunks: Math.max(0, Math.floor(budget.maxChunks)),
    maxExcerptCharsPerChunk: Math.max(0, Math.floor(budget.maxExcerptCharsPerChunk)),
    maxTotalExcerptChars: Math.max(0, Math.floor(budget.maxTotalExcerptChars)),
    sourceKindAllowlist: budget.sourceKindAllowlist.filter((kind) => kind !== "unknown"),
    sensitivityRedactionPolicy: budget.sensitivityRedactionPolicy
  };
}

/**
 * Builds a bounded audit query hash without storing raw query text.
 *
 * @param query - Retrieval query.
 * @returns SHA-256 hash.
 */
function buildSourceRecallQueryHash(query: SourceRecallRetrievalQuery): string {
  return hashSha256(JSON.stringify({
    scopeId: query.scopeId ?? null,
    threadId: query.threadId ?? null,
    sourceRecordId: query.sourceRecordId ?? null,
    chunkId: query.chunkId ?? null,
    exactQuote: query.exactQuote ?? null,
    sourceKinds: query.sourceKinds ?? null,
    keywords: query.keywords ?? null,
    semanticVectorChunkIds: query.semanticVectorChunkIds ?? null
  }));
}

/**
 * Resolves retrieval mode for the S5A exact retriever.
 *
 * @param query - Retrieval query.
 * @returns Retrieval mode.
 */
function resolveRetrievalMode(query: SourceRecallRetrievalQuery): SourceRecallRetrievalMode {
  if (query.sourceRecordId || query.chunkId) {
    return "source_id";
  }
  if (query.exactQuote) {
    return "exact_quote";
  }
  if (query.keywords?.length && query.semanticVectorChunkIds?.length) {
    return "hybrid";
  }
  if (query.semanticVectorChunkIds?.length) {
    return "semantic_vector";
  }
  if (query.keywords?.length) {
    return "keyword";
  }
  if (query.scopeId || query.threadId) {
    return "scope_thread_filter";
  }
  return "recent_fallback";
}

/**
 * Resolves retrieval authority for the S5A exact retriever.
 *
 * @param query - Retrieval query.
 * @returns Retrieval authority.
 */
function resolveRetrievalAuthority(
  query: SourceRecallRetrievalQuery
): SourceRecallRetrievalAuthority {
  if (query.sourceRecordId || query.chunkId) {
    return "exact_source_ref";
  }
  if (query.exactQuote) {
    return "strong_recall_evidence";
  }
  if (query.keywords?.length || query.semanticVectorChunkIds?.length) {
    return "weak_recall_evidence";
  }
  return "diagnostic_only";
}

/**
 * Returns whether record and chunk lifecycle states are visible.
 *
 * @param record - Candidate source record.
 * @param chunk - Candidate chunk.
 * @returns `true` when both are active.
 */
function isRecordAndChunkVisible(record: SourceRecallRecord, chunk: SourceRecallChunk): boolean {
  return (
    isSourceRecallLifecycleVisible(record.lifecycleState) &&
    isSourceRecallLifecycleVisible(chunk.lifecycleState)
  );
}

/**
 * Applies record-level retrieval filters.
 *
 * @param record - Candidate source record.
 * @param query - Retrieval query.
 * @param budget - Normalized output budget.
 * @returns `true` when the record matches.
 */
function matchesRecordQuery(
  record: SourceRecallRecord,
  query: SourceRecallRetrievalQuery,
  budget: SourceRecallOutputBudget
): boolean {
  if (query.scopeId && record.scopeId !== query.scopeId) {
    return false;
  }
  if (query.threadId && record.threadId !== query.threadId) {
    return false;
  }
  if (query.sourceRecordId && record.sourceRecordId !== query.sourceRecordId) {
    return false;
  }
  if (query.sourceKinds && !query.sourceKinds.includes(record.sourceKind)) {
    return false;
  }
  return budget.sourceKindAllowlist.includes(record.sourceKind);
}

/**
 * Builds one bounded excerpt for a candidate chunk.
 *
 * @param candidate - Record/chunk pair.
 * @param exactQuote - Optional exact quote.
 * @param budget - Output budget.
 * @returns Source Recall excerpt.
 */
function buildBudgetedExcerpt(
  candidate: CandidateChunk,
  exactQuote: string | null,
  budget: SourceRecallOutputBudget
): SourceRecallExcerpt {
  if (candidate.record.sensitive) {
    return {
      sourceRecordId: candidate.record.sourceRecordId,
      chunkId: candidate.chunk.chunkId,
      excerpt: "[redacted sensitive source chunk]".slice(0, budget.maxExcerptCharsPerChunk),
      redacted: true,
      recallAuthority: "quoted_evidence_only",
      authority: buildSourceRecallAuthorityFlags(),
      ranking: candidate.ranking
    };
  }

  const sourceText = candidate.chunk.text;
  if (!exactQuote) {
    return buildExcerpt(candidate, sourceText.slice(0, budget.maxExcerptCharsPerChunk), false);
  }
  const index = sourceText.indexOf(exactQuote);
  if (index < 0) {
    return buildExcerpt(candidate, sourceText.slice(0, budget.maxExcerptCharsPerChunk), false);
  }
  const halfWindow = Math.max(0, Math.floor((budget.maxExcerptCharsPerChunk - exactQuote.length) / 2));
  const start = Math.max(0, index - halfWindow);
  return buildExcerpt(
    candidate,
    sourceText.slice(start, start + budget.maxExcerptCharsPerChunk),
    false
  );
}

/**
 * Builds one Source Recall excerpt with non-authority flags.
 *
 * @param candidate - Record/chunk pair.
 * @param excerpt - Bounded excerpt text.
 * @param redacted - Whether excerpt was redacted.
 * @returns Source Recall excerpt.
 */
function buildExcerpt(
  candidate: CandidateChunk,
  excerpt: string,
  redacted: boolean
): SourceRecallExcerpt {
  return {
    sourceRecordId: candidate.record.sourceRecordId,
    chunkId: candidate.chunk.chunkId,
    excerpt,
    redacted,
    recallAuthority: "quoted_evidence_only",
    authority: buildSourceRecallAuthorityFlags(),
    ranking: candidate.ranking
  };
}

/**
 * Builds bounded ranking evidence for one candidate.
 *
 * @param record - Candidate record.
 * @param chunk - Candidate chunk.
 * @param query - Retrieval query.
 * @param retrievalMode - Resolved retrieval mode.
 * @param retrievalAuthority - Resolved retrieval authority.
 * @returns Ranking evidence, or `null` when keyword/vector query filters do not match.
 */
function scoreCandidate(
  record: SourceRecallRecord,
  chunk: SourceRecallChunk,
  query: SourceRecallRetrievalQuery,
  retrievalMode: SourceRecallRetrievalMode,
  retrievalAuthority: SourceRecallRetrievalAuthority
): SourceRecallRankingEvidence | null {
  const keywords = normalizeRetrievalKeywords(query.keywords ?? []);
  const semanticChunkIds = new Set(query.semanticVectorChunkIds ?? []);
  const keywordScore = countKeywordMatches(chunk.text, keywords);
  const vectorScore = semanticChunkIds.has(chunk.chunkId) ? 1 : 0;

  if ((retrievalMode === "keyword" || retrievalMode === "hybrid") && keywordScore === 0) {
    return null;
  }
  if (
    (retrievalMode === "semantic_vector" || retrievalMode === "hybrid") &&
    vectorScore === 0
  ) {
    return null;
  }

  const exactScore = query.sourceRecordId || query.chunkId ? 100 : query.exactQuote ? 75 : 0;
  const score = exactScore + keywordScore * 10 + vectorScore * 25 + freshnessScore(record);
  return {
    retrievalMode,
    retrievalAuthority,
    score,
    explanation: buildRankingExplanation({
      retrievalMode,
      keywordScore,
      vectorScore,
      freshness: record.freshness,
      sourceTimeKind: record.sourceTimeKind
    }),
    freshness: record.freshness,
    sourceTimeKind: record.sourceTimeKind,
    keywordScore,
    vectorScore
  };
}

/**
 * Sorts recall candidates by bounded retrieval evidence only.
 *
 * @param left - Left candidate.
 * @param right - Right candidate.
 * @returns Sort order.
 */
function compareCandidates(left: CandidateChunk, right: CandidateChunk): number {
  if (right.ranking.score !== left.ranking.score) {
    return right.ranking.score - left.ranking.score;
  }
  if (right.record.capturedAt !== left.record.capturedAt) {
    return right.record.capturedAt.localeCompare(left.record.capturedAt);
  }
  return left.chunk.chunkId.localeCompare(right.chunk.chunkId);
}

/**
 * Normalizes retrieval keywords without retaining raw query text in audit events.
 *
 * @param keywords - Candidate keywords.
 * @returns Lower-cased non-empty keywords.
 */
function normalizeRetrievalKeywords(keywords: readonly string[]): string[] {
  return keywords
    .map((keyword) => keyword.trim().toLowerCase())
    .filter((keyword) => keyword.length > 0);
}

/**
 * Counts keyword matches for retrieval ranking.
 *
 * @param text - Candidate chunk text.
 * @param keywords - Normalized keywords.
 * @returns Match count.
 */
function countKeywordMatches(text: string, keywords: readonly string[]): number {
  if (keywords.length === 0) {
    return 0;
  }
  const lowerText = text.toLowerCase();
  return keywords.reduce((count, keyword) => count + (lowerText.includes(keyword) ? 1 : 0), 0);
}

/**
 * Converts freshness into a small ranking tie-breaker.
 *
 * @param record - Candidate record.
 * @returns Freshness score.
 */
function freshnessScore(record: SourceRecallRecord): number {
  switch (record.freshness) {
    case "current_turn":
      return 4;
    case "recent":
      return 3;
    case "historical":
      return 2;
    case "stale":
      return 1;
    default:
      return 0;
  }
}

/**
 * Builds a bounded ranking explanation without raw source text.
 *
 * @param input - Ranking evidence fields.
 * @returns Short ranking explanation.
 */
function buildRankingExplanation(input: {
  retrievalMode: SourceRecallRetrievalMode;
  keywordScore: number;
  vectorScore: number;
  freshness: SourceRecallRecord["freshness"];
  sourceTimeKind: SourceRecallRecord["sourceTimeKind"];
}): string {
  return [
    `mode=${input.retrievalMode}`,
    `keywordScore=${input.keywordScore}`,
    `vectorScore=${input.vectorScore}`,
    `freshness=${input.freshness}`,
    `sourceTimeKind=${input.sourceTimeKind}`
  ].join("; ");
}
