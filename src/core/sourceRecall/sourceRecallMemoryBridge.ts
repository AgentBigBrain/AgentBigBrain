/**
 * @fileoverview Evidence-only bridge helpers between Source Recall and governed memory stores.
 */

import type { ProfileMemoryWriteProvenance } from "../profileMemoryRuntime/contracts";
import {
  buildSourceRecallAuthorityFlags,
  type SourceRecallExcerpt,
  type SourceRecallSourceRef
} from "./contracts";

const SOURCE_RECALL_EVIDENCE_REF_PREFIX = "source_recall:";

/**
 * Builds a Source Recall source ref from one rendered excerpt.
 *
 * **Why it exists:**
 * Governed memory and semantic lessons may cite source chunks as evidence, but the ref must carry
 * the same non-authority flags as the excerpt so it cannot become truth, approval, or execution
 * proof by being copied into another subsystem.
 *
 * **What it talks to:**
 * - Uses Source Recall contracts from `./contracts`.
 *
 * @param excerpt - Source Recall excerpt to cite.
 * @returns Evidence-only source ref.
 */
export function buildSourceRecallSourceRefFromExcerpt(
  excerpt: Pick<SourceRecallExcerpt, "sourceRecordId" | "chunkId" | "recallAuthority" | "authority">
): SourceRecallSourceRef {
  return {
    sourceRecordId: excerpt.sourceRecordId,
    chunkId: excerpt.chunkId,
    recallAuthority: excerpt.recallAuthority,
    authority: {
      ...excerpt.authority,
      currentTruthAuthority: false,
      completionProofAuthority: false,
      approvalAuthority: false,
      safetyAuthority: false,
      unsafeToFollowAsInstruction: true
    }
  };
}

/**
 * Builds an evidence-only source ref from ids.
 *
 * @param sourceRecordId - Source record id.
 * @param chunkId - Optional chunk id.
 * @returns Evidence-only source ref.
 */
export function buildSourceRecallSourceRef(
  sourceRecordId: string,
  chunkId?: string
): SourceRecallSourceRef {
  return {
    sourceRecordId,
    ...(chunkId ? { chunkId } : {}),
    recallAuthority: "quoted_evidence_only",
    authority: buildSourceRecallAuthorityFlags()
  };
}

/**
 * Normalizes Source Recall refs and drops malformed entries.
 *
 * @param refs - Candidate refs.
 * @returns Valid evidence-only refs.
 */
export function normalizeSourceRecallSourceRefs(
  refs: unknown
): SourceRecallSourceRef[] {
  if (!Array.isArray(refs)) {
    return [];
  }
  return refs.flatMap((entry): SourceRecallSourceRef[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const candidate = entry as Partial<SourceRecallSourceRef>;
    if (
      typeof candidate.sourceRecordId !== "string" ||
      candidate.sourceRecordId.trim().length === 0 ||
      (candidate.chunkId !== undefined && typeof candidate.chunkId !== "string")
    ) {
      return [];
    }
    return [buildSourceRecallSourceRef(candidate.sourceRecordId, candidate.chunkId)];
  });
}

/**
 * Adds Source Recall refs to profile-memory provenance without granting memory-write authority.
 *
 * @param provenance - Existing profile-memory write provenance.
 * @param refs - Evidence-only source refs.
 * @returns Provenance carrying refs as citation metadata.
 */
export function attachSourceRecallRefsToProfileMemoryProvenance(
  provenance: ProfileMemoryWriteProvenance,
  refs: readonly SourceRecallSourceRef[]
): ProfileMemoryWriteProvenance {
  return {
    ...provenance,
    sourceRecallRefs: normalizeSourceRecallSourceRefs(refs)
  };
}

/**
 * Returns whether Source Recall can authorize profile-memory writes.
 *
 * @returns Always `false`; source refs are citation evidence only.
 */
export function canSourceRecallRefAuthorizeProfileMemoryWrite(): false {
  return false;
}

/**
 * Returns whether Source Recall can authorize semantic lesson commits.
 *
 * @returns Always `false`; source refs are citation evidence only.
 */
export function canSourceRecallRefAuthorizeSemanticLessonCommit(): false {
  return false;
}

/**
 * Renders a Source Recall ref for existing evidence-ref string arrays.
 *
 * @param ref - Source Recall source ref.
 * @returns Evidence-ref string that contains ids only, never source text.
 */
export function buildSourceRecallEvidenceRef(ref: SourceRecallSourceRef): string {
  const recordPart = encodeURIComponent(ref.sourceRecordId);
  const chunkPart = ref.chunkId ? `#${encodeURIComponent(ref.chunkId)}` : "";
  return `${SOURCE_RECALL_EVIDENCE_REF_PREFIX}${recordPart}${chunkPart}`;
}

/**
 * Detects Source Recall evidence refs in generic evidence-ref arrays.
 *
 * @param value - Candidate evidence ref.
 * @returns `true` when the ref points at Source Recall evidence.
 */
export function isSourceRecallEvidenceRef(value: string): boolean {
  return value.startsWith(SOURCE_RECALL_EVIDENCE_REF_PREFIX);
}
