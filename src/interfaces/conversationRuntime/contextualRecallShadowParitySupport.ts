/**
 * @fileoverview Shared shadow-parity and weak-recall suppression helpers for contextual recall.
 */

import { tokenizeTopicTerms } from "./contextualRecallSupport";
import type { ContextualRecallCandidate } from "./contextualRecallRanking";
import type { InterpretedContextualReferenceHints } from "./contextualReferenceInterpretationSupport";

const GENERIC_RECALL_DETAIL_TERMS = new Set([
  "ago",
  "few",
  "situation",
  "thing",
  "whole",
  "week",
  "weeks"
]);

interface WeakContextualRecallResolvedReference {
  directTerms: readonly string[];
  hasRecallCue: boolean;
  usedFallbackContext: boolean;
}

/**
 * Describes bounded shadow-parity mismatch fields in human-readable form.
 *
 * @param fields - Canonical mismatch field ids.
 * @returns Comma-separated human-readable labels.
 */
export function describeRecallShadowParityMismatchFields(
  fields: readonly string[]
): string {
  const labels = fields.map((field) => {
    switch (field) {
      case "compatibility_suppressed":
        return "compatibility suppression";
      case "answer_mode":
        return "answer mode";
      case "current_state":
        return "current-state summary";
      case "historical_context":
        return "historical-context summary";
      case "contradiction_notes":
        return "contradiction summary";
      case "lane_boundaries":
        return "lane boundaries";
      case "rendered_split_view":
        return "rendered split view";
      default:
        return "shadow parity";
    }
  });
  return [...new Set(labels)].join(", ");
}

/**
 * Suppresses weak contextual recall revivals when the current turn lacks a real recall cue.
 *
 * @param candidate - Recall candidate under evaluation.
 * @param resolvedReference - Deterministic contextual-reference result for the current turn.
 * @param mediaRecallHints - Optional continuity hints from the media path.
 * @param interpretedHints - Optional model-assisted contextual recall hints.
 * @returns `true` when the candidate should fail closed.
 */
export function shouldSuppressWeakContextualRecallCandidate(
  candidate: ContextualRecallCandidate,
  resolvedReference: WeakContextualRecallResolvedReference,
  mediaRecallHints: readonly string[] = [],
  interpretedHints: InterpretedContextualReferenceHints | null = null
): boolean {
  if (
    candidate.matchSource === "open_loop_resume" &&
    interpretedHints?.kind === "open_loop_resume_reference"
  ) {
    return false;
  }
  const directTerms = resolvedReference.directTerms;
  const candidateTerms = tokenizeTopicTerms([
    candidate.topicLabel,
    candidate.episodeSummary ?? "",
    ...(candidate.entityRefs ?? [])
  ].join(" "));
  const mediaOverlap = mediaRecallHints.filter((term) => candidateTerms.includes(term)).length;

  if (resolvedReference.hasRecallCue || mediaOverlap >= 2) {
    return false;
  }
  if (hasStrongDirectEpisodeOverlap(candidate, directTerms)) {
    return false;
  }
  if (!resolvedReference.usedFallbackContext) {
    return true;
  }
  const directOverlap = directTerms.filter((term) => candidateTerms.includes(term)).length;
  return directOverlap <= 1;
}

/**
 * Detects strong direct overlap between the current turn and one episode candidate.
 *
 * @param candidate - Recall candidate under evaluation.
 * @param directTerms - Directly extracted terms from the current user turn.
 * @returns `true` when the turn overlaps both the episode entity and a concrete situation detail.
 */
function hasStrongDirectEpisodeOverlap(
  candidate: ContextualRecallCandidate,
  directTerms: readonly string[]
): boolean {
  if (candidate.kind !== "episode") {
    return false;
  }

  const entityTerms = tokenizeTopicTerms((candidate.entityRefs ?? []).join(" "));
  const detailTerms = tokenizeTopicTerms([
    candidate.topicLabel,
    candidate.episodeSummary ?? ""
  ].join(" "))
    .filter((term) => !GENERIC_RECALL_DETAIL_TERMS.has(term))
    .filter((term) => !entityTerms.includes(term));
  const directEntityOverlap = directTerms.filter((term) => entityTerms.includes(term)).length;
  const directDetailOverlap = directTerms.filter((term) => detailTerms.includes(term)).length;
  return directEntityOverlap > 0 && directDetailOverlap > 0;
}
