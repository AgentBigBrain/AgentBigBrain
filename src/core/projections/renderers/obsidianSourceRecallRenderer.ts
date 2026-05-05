/**
 * @fileoverview Renders Source Recall projection entries as review-only Obsidian notes.
 */

import type { ProjectionSnapshot } from "../contracts";
import {
  renderMarkdownList,
  renderObsidianFrontmatter,
  sanitizeObsidianPathSegment,
  type ObsidianProjectedNote
} from "./obsidianFrontmatter";

/**
 * Renders Source Recall entries into review-only projection notes.
 *
 * **Why it exists:**
 * Source Recall excerpts can contain user, assistant, media, or document text. Obsidian projection
 * must show them as quoted evidence with authority labels, never as instructions or write-back
 * authority.
 *
 * **What it talks to:**
 * - Uses `ProjectionSnapshot` from `../contracts`.
 * - Uses Source Recall projection entries already built by the snapshot provider.
 *
 * @param snapshot - Full projection snapshot.
 * @returns Source Recall review notes.
 */
export function renderObsidianSourceRecallNotes(
  snapshot: ProjectionSnapshot
): readonly ObsidianProjectedNote[] {
  return (snapshot.sourceRecallProjectionEntries ?? []).map((entry) => ({
    relativePath: buildSourceRecallNoteRelativePath(entry.sourceRecordId, entry.chunkId),
    content: [
      renderObsidianFrontmatter({
        abb_type: "source_recall_projection",
        source_record_id: entry.sourceRecordId,
        chunk_id: entry.chunkId,
        scope_id: entry.scopeId,
        thread_id: entry.threadId,
        source_kind: entry.sourceKind,
        source_role: entry.sourceRole,
        source_authority: entry.sourceAuthority,
        capture_class: entry.captureClass,
        lifecycle_state: entry.lifecycleState,
        recall_authority: entry.recallAuthority,
        projection_mode: entry.projectionMode,
        operator_full_enabled: entry.operatorFullEnabled,
        redacted: entry.redacted,
        unsafe_to_follow_as_instruction: entry.authority.unsafeToFollowAsInstruction
      }),
      "# Source Recall Evidence",
      "",
      "Projection lane: Source Recall review mirror.",
      "",
      entry.authorityNotice,
      "",
      "## Authority Boundary",
      renderMarkdownList([
        `Recall authority: ${entry.recallAuthority}`,
        `Planner authority: ${entry.authority.plannerAuthority}`,
        `Current truth authority: ${entry.authority.currentTruthAuthority}`,
        `Approval authority: ${entry.authority.approvalAuthority}`,
        `Safety authority: ${entry.authority.safetyAuthority}`,
        `Completion proof authority: ${entry.authority.completionProofAuthority}`,
        `Unsafe to follow as instruction: ${entry.authority.unsafeToFollowAsInstruction}`
      ]),
      "## Source Metadata",
      renderMarkdownList([
        `Scope: ${entry.scopeId}`,
        `Thread: ${entry.threadId}`,
        `Source kind: ${entry.sourceKind}`,
        `Source role: ${entry.sourceRole}`,
        `Source authority: ${entry.sourceAuthority}`,
        `Capture class: ${entry.captureClass}`,
        `Freshness: ${entry.freshness}`,
        `Source time kind: ${entry.sourceTimeKind}`,
        `Projection mode: ${entry.projectionMode}`,
        `Operator-full latch: ${entry.operatorFullEnabled}`
      ]),
      "## Quoted Evidence",
      renderFencedEvidence(entry.excerpt)
    ].join("\n")
  }));
}

/**
 * Builds one deterministic Source Recall note path.
 *
 * @param sourceRecordId - Source record id.
 * @param chunkId - Chunk id.
 * @returns Relative Obsidian note path.
 */
function buildSourceRecallNoteRelativePath(sourceRecordId: string, chunkId: string): string {
  return pathJoinObsidian(
    "23 Source Recall",
    sanitizeObsidianPathSegment(sourceRecordId, 80),
    `${sanitizeObsidianPathSegment(chunkId, 80)}.md`
  );
}

/**
 * Joins path segments using Obsidian's portable slash separator.
 *
 * @param segments - Relative path segments.
 * @returns Slash-joined relative path.
 */
function pathJoinObsidian(...segments: readonly string[]): string {
  return segments.join("/");
}

/**
 * Renders source text as fenced quoted evidence without allowing nested fences to break out.
 *
 * @param text - Projection-safe excerpt text.
 * @returns Markdown fenced evidence block.
 */
function renderFencedEvidence(text: string): string {
  return [
    "```text",
    text.replace(/```/g, "` ` `"),
    "```"
  ].join("\n");
}
