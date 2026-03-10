/**
 * @fileoverview Builds bounded continuity hints from interpreted inbound media.
 */

import type { ConversationInboundMediaEnvelope } from "../../interfaces/mediaRuntime/contracts";
import {
  extractContextualRecallTerms,
  extractConversationTopicTerms
} from "../languageRuntime/queryIntentTerms";

const MAX_MEDIA_CONTINUITY_HINTS = 8;

export interface MediaContinuityHints {
  recallHints: readonly string[];
  evidence: readonly string[];
}

/**
 * Adds weighted contextual-recall and topic terms from one text fragment into the bounded scorer.
 *
 * @param target - Weighted term map being accumulated.
 * @param text - Text fragment to tokenize.
 * @param weight - Base weight for extracted terms.
 */
function addBoundedTerms(target: Map<string, number>, text: string, weight: number): void {
  for (const term of extractContextualRecallTerms(text)) {
    target.set(term, (target.get(term) ?? 0) + weight);
  }
  for (const term of extractConversationTopicTerms(text)) {
    target.set(term, (target.get(term) ?? 0) + Math.max(1, weight - 1));
  }
}

/**
 * Builds deterministic continuity hints from one interpreted media envelope.
 *
 * @param media - Optional interpreted inbound media envelope.
 * @param maxHints - Maximum number of hints returned.
 * @returns Bounded continuity hints derived from interpretation output.
 */
export function buildMediaContinuityHints(
  media: ConversationInboundMediaEnvelope | null | undefined,
  maxHints = MAX_MEDIA_CONTINUITY_HINTS
): MediaContinuityHints {
  const attachments = media?.attachments ?? [];
  if (attachments.length === 0) {
    return {
      recallHints: [],
      evidence: []
    };
  }

  const weightedTerms = new Map<string, number>();
  const evidence = new Set<string>();

  for (const attachment of attachments) {
    for (const hint of attachment.interpretation?.entityHints ?? []) {
      for (const term of extractContextualRecallTerms(hint)) {
        weightedTerms.set(term, (weightedTerms.get(term) ?? 0) + 6);
        evidence.add("entity_hints");
      }
    }

    if (attachment.caption) {
      addBoundedTerms(weightedTerms, attachment.caption, 3);
      evidence.add("caption");
    }
    if (attachment.interpretation?.summary) {
      addBoundedTerms(weightedTerms, attachment.interpretation.summary, 4);
      evidence.add("summary");
    }
    if (attachment.interpretation?.transcript) {
      addBoundedTerms(weightedTerms, attachment.interpretation.transcript, 5);
      evidence.add("transcript");
    }
    if (attachment.interpretation?.ocrText) {
      addBoundedTerms(weightedTerms, attachment.interpretation.ocrText, 4);
      evidence.add("ocr");
    }
  }

  const recallHints = [...weightedTerms.entries()]
    .sort((left, right) => {
      if (left[1] !== right[1]) {
        return right[1] - left[1];
      }
      return left[0].localeCompare(right[0]);
    })
    .slice(0, maxHints)
    .map(([term]) => term);

  return {
    recallHints,
    evidence: [...evidence].sort()
  };
}
