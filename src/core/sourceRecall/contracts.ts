/**
 * @fileoverview Shared contracts for Source Recall records, chunks, excerpts, and recall bundles.
 */

import type { SourceAuthority } from "../sourceAuthority";
import { normalizeSourceAuthority } from "../sourceAuthority";

export type SourceRecallSourceKind =
  | "conversation_turn"
  | "assistant_turn"
  | "task_input"
  | "task_summary"
  | "document_text"
  | "document_model_summary"
  | "media_transcript"
  | "ocr_text"
  | "media_model_summary"
  | "review_note"
  | "execution_receipt_excerpt"
  | "unknown";

export type SourceRecallSourceRole =
  | "user"
  | "assistant"
  | "tool"
  | "external_agent"
  | "runtime"
  | "operator_review"
  | "test_fixture"
  | "unknown";

export type SourceRecallCaptureClass =
  | "ordinary_source"
  | "assistant_output"
  | "operational_output"
  | "external_output"
  | "policy_metadata"
  | "runtime_control_metadata"
  | "projection_metadata"
  | "test_fixture"
  | "repository_reference"
  | "excluded_by_default";

export type SourceRecallAuthority = "quoted_evidence_only";

export type SourceRecallLifecycleState =
  | "active"
  | "redacted"
  | "forgotten"
  | "expired"
  | "quarantined"
  | "projection_only_removed";

export type SourceRecallRetrievalMode =
  | "source_id"
  | "exact_quote"
  | "scope_thread_filter"
  | "semantic_vector"
  | "hybrid"
  | "keyword"
  | "recent_fallback";

export type SourceRecallRetrievalAuthority =
  | "exact_source_ref"
  | "strong_recall_evidence"
  | "weak_recall_evidence"
  | "diagnostic_only";

export type SourceRecallFreshness =
  | "current_turn"
  | "recent"
  | "historical"
  | "stale"
  | "unknown";

export type SourceRecallSourceTimeKind =
  | "observed_event"
  | "captured_record"
  | "generated_summary"
  | "unknown";

export interface SourceRecallOriginRef {
  surface: string;
  refId: string;
  parentRefId?: string;
}

export interface SourceRecallSourceRef {
  sourceRecordId: string;
  chunkId?: string;
  recallAuthority: SourceRecallAuthority;
  authority: SourceRecallAuthorityFlags;
}

export interface SourceRecallOutputBudget {
  maxRecords: number;
  maxChunks: number;
  maxExcerptCharsPerChunk: number;
  maxTotalExcerptChars: number;
  sourceKindAllowlist: readonly SourceRecallSourceKind[];
  sensitivityRedactionPolicy: "redact_sensitive" | "exclude_sensitive";
}

export interface SourceRecallAuthorityFlags {
  currentTruthAuthority: false;
  plannerAuthority: "evidence_only" | "none";
  completionProofAuthority: false;
  approvalAuthority: false;
  safetyAuthority: false;
  unsafeToFollowAsInstruction: true;
}

export interface SourceRecallRecord {
  sourceRecordId: string;
  scopeId: string;
  threadId: string;
  sourceKind: SourceRecallSourceKind;
  sourceRole: SourceRecallSourceRole;
  sourceAuthority: SourceAuthority;
  captureClass: SourceRecallCaptureClass;
  recallAuthority: SourceRecallAuthority;
  lifecycleState: SourceRecallLifecycleState;
  originRef: SourceRecallOriginRef;
  sourceRecordHash: string;
  observedAt: string;
  capturedAt: string;
  sourceTimeKind: SourceRecallSourceTimeKind;
  freshness: SourceRecallFreshness;
  sensitive: boolean;
}

export interface SourceRecallChunk {
  chunkId: string;
  sourceRecordId: string;
  chunkIndex: number;
  text: string;
  chunkHash: string;
  lifecycleState: SourceRecallLifecycleState;
  recallAuthority: SourceRecallAuthority;
  authority: SourceRecallAuthorityFlags;
}

export interface SourceRecallExcerpt {
  sourceRecordId: string;
  chunkId: string;
  excerpt: string;
  redacted: boolean;
  recallAuthority: SourceRecallAuthority;
  authority: SourceRecallAuthorityFlags;
  ranking: SourceRecallRankingEvidence;
}

export interface SourceRecallBundle {
  scopeId: string;
  threadId: string;
  retrievalMode: SourceRecallRetrievalMode;
  retrievalAuthority: SourceRecallRetrievalAuthority;
  budget: SourceRecallOutputBudget;
  excerpts: readonly SourceRecallExcerpt[];
  authority: SourceRecallAuthorityFlags;
}

export interface SourceRecallRankingEvidence {
  retrievalMode: SourceRecallRetrievalMode;
  retrievalAuthority: SourceRecallRetrievalAuthority;
  score: number;
  explanation: string;
  freshness: SourceRecallFreshness;
  sourceTimeKind: SourceRecallSourceTimeKind;
  keywordScore: number;
  vectorScore: number;
}

export const SOURCE_RECALL_SOURCE_KIND_VALUES: readonly SourceRecallSourceKind[] = [
  "conversation_turn",
  "assistant_turn",
  "task_input",
  "task_summary",
  "document_text",
  "document_model_summary",
  "media_transcript",
  "ocr_text",
  "media_model_summary",
  "review_note",
  "execution_receipt_excerpt",
  "unknown"
] as const;

export const SOURCE_RECALL_SOURCE_ROLE_VALUES: readonly SourceRecallSourceRole[] = [
  "user",
  "assistant",
  "tool",
  "external_agent",
  "runtime",
  "operator_review",
  "test_fixture",
  "unknown"
] as const;

export const SOURCE_RECALL_CAPTURE_CLASS_VALUES: readonly SourceRecallCaptureClass[] = [
  "ordinary_source",
  "assistant_output",
  "operational_output",
  "external_output",
  "policy_metadata",
  "runtime_control_metadata",
  "projection_metadata",
  "test_fixture",
  "repository_reference",
  "excluded_by_default"
] as const;

export const SOURCE_RECALL_LIFECYCLE_STATE_VALUES: readonly SourceRecallLifecycleState[] = [
  "active",
  "redacted",
  "forgotten",
  "expired",
  "quarantined",
  "projection_only_removed"
] as const;

export const SOURCE_RECALL_RETRIEVAL_MODE_VALUES: readonly SourceRecallRetrievalMode[] = [
  "source_id",
  "exact_quote",
  "scope_thread_filter",
  "semantic_vector",
  "hybrid",
  "keyword",
  "recent_fallback"
] as const;

export const SOURCE_RECALL_RETRIEVAL_AUTHORITY_VALUES: readonly SourceRecallRetrievalAuthority[] = [
  "exact_source_ref",
  "strong_recall_evidence",
  "weak_recall_evidence",
  "diagnostic_only"
] as const;

export const SOURCE_RECALL_FRESHNESS_VALUES: readonly SourceRecallFreshness[] = [
  "current_turn",
  "recent",
  "historical",
  "stale",
  "unknown"
] as const;

export const SOURCE_RECALL_SOURCE_TIME_KIND_VALUES: readonly SourceRecallSourceTimeKind[] = [
  "observed_event",
  "captured_record",
  "generated_summary",
  "unknown"
] as const;

const SOURCE_RECALL_SOURCE_KIND_SET = new Set<SourceRecallSourceKind>(
  SOURCE_RECALL_SOURCE_KIND_VALUES
);
const SOURCE_RECALL_SOURCE_ROLE_SET = new Set<SourceRecallSourceRole>(
  SOURCE_RECALL_SOURCE_ROLE_VALUES
);
const SOURCE_RECALL_CAPTURE_CLASS_SET = new Set<SourceRecallCaptureClass>(
  SOURCE_RECALL_CAPTURE_CLASS_VALUES
);
const SOURCE_RECALL_LIFECYCLE_STATE_SET = new Set<SourceRecallLifecycleState>(
  SOURCE_RECALL_LIFECYCLE_STATE_VALUES
);
const SOURCE_RECALL_RETRIEVAL_MODE_SET = new Set<SourceRecallRetrievalMode>(
  SOURCE_RECALL_RETRIEVAL_MODE_VALUES
);
const SOURCE_RECALL_RETRIEVAL_AUTHORITY_SET = new Set<SourceRecallRetrievalAuthority>(
  SOURCE_RECALL_RETRIEVAL_AUTHORITY_VALUES
);
const SOURCE_RECALL_FRESHNESS_SET = new Set<SourceRecallFreshness>(
  SOURCE_RECALL_FRESHNESS_VALUES
);
const SOURCE_RECALL_SOURCE_TIME_KIND_SET = new Set<SourceRecallSourceTimeKind>(
  SOURCE_RECALL_SOURCE_TIME_KIND_VALUES
);

/**
 * Builds the only authority flags a Source Recall artifact may carry.
 *
 * **Why it exists:**
 * Source Recall needs a reusable authority shape so records, chunks, excerpts, and bundles cannot
 * drift into planner, truth, approval, safety, or completion authority as implementation expands.
 *
 * **What it talks to:**
 * - Uses local type contracts within this module.
 *
 * @param plannerAuthority - Evidence-only planner visibility, or `none` for diagnostic outputs.
 * @returns Non-authority flags for Source Recall artifacts.
 */
export function buildSourceRecallAuthorityFlags(
  plannerAuthority: SourceRecallAuthorityFlags["plannerAuthority"] = "evidence_only"
): SourceRecallAuthorityFlags {
  return {
    currentTruthAuthority: false,
    plannerAuthority,
    completionProofAuthority: false,
    approvalAuthority: false,
    safetyAuthority: false,
    unsafeToFollowAsInstruction: true
  };
}

/**
 * Normalizes source kind while preserving fail-closed unknown handling.
 *
 * **Why it exists:**
 * Runtime capture surfaces will arrive incrementally. Unknown kinds must not gain authority by
 * being treated as ordinary conversation or media source text.
 *
 * **What it talks to:**
 * - Uses local constants within this module.
 *
 * @param value - Candidate source kind.
 * @returns Canonical source kind, or `unknown` when unrecognized.
 */
export function normalizeSourceRecallSourceKind(value: unknown): SourceRecallSourceKind {
  return typeof value === "string" && SOURCE_RECALL_SOURCE_KIND_SET.has(value as SourceRecallSourceKind)
    ? (value as SourceRecallSourceKind)
    : "unknown";
}

/**
 * Normalizes the role that produced a source record.
 *
 * **Why it exists:**
 * Assistant, tool, test, and user text have different evidence meaning. Keeping role separate from
 * source kind prevents assistant or fixture output from masquerading as user source.
 *
 * **What it talks to:**
 * - Uses local constants within this module.
 *
 * @param value - Candidate source role.
 * @returns Canonical source role, or `unknown` when unrecognized.
 */
export function normalizeSourceRecallSourceRole(value: unknown): SourceRecallSourceRole {
  return typeof value === "string" && SOURCE_RECALL_SOURCE_ROLE_SET.has(value as SourceRecallSourceRole)
    ? (value as SourceRecallSourceRole)
    : "unknown";
}

/**
 * Normalizes the capture class for a source-adjacent surface.
 *
 * **Why it exists:**
 * Capture class is the firewall between ordinary source material and operational, projection,
 * repository, fixture, or excluded metadata that should not enter production recall by default.
 *
 * **What it talks to:**
 * - Uses local constants within this module.
 *
 * @param value - Candidate capture class.
 * @returns Canonical capture class, defaulting to `excluded_by_default`.
 */
export function normalizeSourceRecallCaptureClass(value: unknown): SourceRecallCaptureClass {
  return typeof value === "string" &&
    SOURCE_RECALL_CAPTURE_CLASS_SET.has(value as SourceRecallCaptureClass)
    ? (value as SourceRecallCaptureClass)
    : "excluded_by_default";
}

/**
 * Normalizes the only recall-authority value Source Recall supports.
 *
 * **Why it exists:**
 * Recall authority must stay intentionally narrow. Anything that looks like approval, proof,
 * safety, planner, or memory authority is rejected to the only non-authoritative value.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Candidate recall authority.
 * @returns `quoted_evidence_only` for every input.
 */
export function normalizeSourceRecallAuthority(value: unknown): SourceRecallAuthority {
  return value === "quoted_evidence_only" ? "quoted_evidence_only" : "quoted_evidence_only";
}

/**
 * Normalizes lifecycle state for source records and chunks.
 *
 * **Why it exists:**
 * Lifecycle state drives deletion, redaction, retention, quarantine, and projection removal without
 * letting callers invent reachable states for forgotten or quarantined content.
 *
 * **What it talks to:**
 * - Uses local constants within this module.
 *
 * @param value - Candidate lifecycle state.
 * @returns Canonical lifecycle state, defaulting to `quarantined`.
 */
export function normalizeSourceRecallLifecycleState(value: unknown): SourceRecallLifecycleState {
  return typeof value === "string" &&
    SOURCE_RECALL_LIFECYCLE_STATE_SET.has(value as SourceRecallLifecycleState)
    ? (value as SourceRecallLifecycleState)
    : "quarantined";
}

/**
 * Normalizes retrieval mode for recall bundles.
 *
 * **Why it exists:**
 * Consumers need to distinguish exact source references from weaker retrieval paths such as keyword
 * or recent fallback before deciding how much evidence to render.
 *
 * **What it talks to:**
 * - Uses local constants within this module.
 *
 * @param value - Candidate retrieval mode.
 * @returns Canonical retrieval mode, defaulting to `recent_fallback`.
 */
export function normalizeSourceRecallRetrievalMode(value: unknown): SourceRecallRetrievalMode {
  return typeof value === "string" &&
    SOURCE_RECALL_RETRIEVAL_MODE_SET.has(value as SourceRecallRetrievalMode)
    ? (value as SourceRecallRetrievalMode)
    : "recent_fallback";
}

/**
 * Normalizes retrieval authority for recall bundles.
 *
 * **Why it exists:**
 * Retrieval confidence is not truth confidence. A closed vocabulary keeps weaker recall evidence
 * visibly separate from exact source references.
 *
 * **What it talks to:**
 * - Uses local constants within this module.
 *
 * @param value - Candidate retrieval authority.
 * @returns Canonical retrieval authority, defaulting to `diagnostic_only`.
 */
export function normalizeSourceRecallRetrievalAuthority(
  value: unknown
): SourceRecallRetrievalAuthority {
  return typeof value === "string" &&
    SOURCE_RECALL_RETRIEVAL_AUTHORITY_SET.has(value as SourceRecallRetrievalAuthority)
    ? (value as SourceRecallRetrievalAuthority)
    : "diagnostic_only";
}

/**
 * Normalizes source freshness for recall bundles.
 *
 * **Why it exists:**
 * Finding old text must not imply current truth. Freshness remains explicit so stale recall stays
 * review evidence rather than current profile or workflow state.
 *
 * **What it talks to:**
 * - Uses local constants within this module.
 *
 * @param value - Candidate freshness label.
 * @returns Canonical freshness label, defaulting to `unknown`.
 */
export function normalizeSourceRecallFreshness(value: unknown): SourceRecallFreshness {
  return typeof value === "string" && SOURCE_RECALL_FRESHNESS_SET.has(value as SourceRecallFreshness)
    ? (value as SourceRecallFreshness)
    : "unknown";
}

/**
 * Normalizes how source time should be interpreted.
 *
 * **Why it exists:**
 * Captured time, observed event time, and generated summary time mean different things for recall
 * and must not be collapsed into current truth.
 *
 * **What it talks to:**
 * - Uses local constants within this module.
 *
 * @param value - Candidate source time kind.
 * @returns Canonical source time kind, defaulting to `unknown`.
 */
export function normalizeSourceRecallSourceTimeKind(value: unknown): SourceRecallSourceTimeKind {
  return typeof value === "string" &&
    SOURCE_RECALL_SOURCE_TIME_KIND_SET.has(value as SourceRecallSourceTimeKind)
    ? (value as SourceRecallSourceTimeKind)
    : "unknown";
}

/**
 * Normalizes Source Recall source authority through the shared authority vocabulary.
 *
 * **Why it exists:**
 * Source Recall should reuse AgentBigBrain's existing authority vocabulary and must not add a broad
 * `source_recall` authority that flattens the original evidence lane.
 *
 * **What it talks to:**
 * - Uses `normalizeSourceAuthority` from `../sourceAuthority`.
 *
 * @param value - Candidate shared source authority.
 * @returns Canonical shared authority with legacy compatibility disallowed.
 */
export function normalizeSourceRecallSourceAuthority(value: unknown): SourceAuthority {
  return normalizeSourceAuthority(value);
}
