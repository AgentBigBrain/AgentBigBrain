/**
 * @fileoverview Qualification helpers for bounded proactive relationship follow-up.
 */

import type { EntityGraphV1 } from "../../core/types";
import type { RelationshipClarificationQualificationRequest } from "./contracts";
import { calculateRelationshipClarificationUtilityScore } from "./userValueScoring";

const RELATIONSHIP_CLARIFICATION_MIN_UTILITY = 0.5;
const MIN_ENTITY_ANCHOR_TOKEN_LENGTH = 3;
const ENTITY_ANCHOR_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "this",
  "that",
  "your",
  "their",
  "about"
]);

/**
 * Counts unresolved open loops across one conversation stack.
 *
 * @param stack - Conversation stack under evaluation.
 * @returns Count of unresolved open loops.
 */
export function countOpenLoops(
  stack: { threads: readonly { openLoops: readonly { status: string }[] }[] }
): number {
  return stack.threads.reduce((total, thread) => {
    return total + thread.openLoops.filter((loop) => loop.status === "open").length;
  }, 0);
}

/**
 * Returns true when the candidate should be suppressed for low user value.
 *
 * @param request - Bounded continuity and recent-conversation signals.
 * @returns `true` when the proactive clarification should be suppressed.
 */
export function shouldSuppressRelationshipClarificationPulse(
  request: RelationshipClarificationQualificationRequest
): boolean {
  if (request.candidate.reasonCode !== "RELATIONSHIP_CLARIFICATION") {
    return false;
  }

  const anchoredEntityCount = request.candidate.entityRefs.filter((entityKey) =>
    recentConversationAnchorsEntity(entityKey, request.graph, request.recentConversationText)
  ).length;

  const utilityScore = calculateRelationshipClarificationUtilityScore({
    anchoredEntityCount,
    openLoopCount: request.openLoopCount,
    repeatedNegativeOutcomes: request.repeatedNegativeOutcomes
  });

  return utilityScore < RELATIONSHIP_CLARIFICATION_MIN_UTILITY;
}

/**
 * Builds normalized anchor tokens from an entity name or alias.
 *
 * @param value - Entity surface text.
 * @returns Stable anchor tokens.
 */
function tokenizeEntityAnchor(value: string): readonly string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) =>
      token.length >= MIN_ENTITY_ANCHOR_TOKEN_LENGTH &&
      !ENTITY_ANCHOR_STOP_WORDS.has(token)
    );
}

/**
 * Returns true when recent conversation text contains any anchor token for the entity.
 *
 * @param entityKey - Entity key selected by dynamic pulse evaluation.
 * @param graph - Current entity graph.
 * @param recentConversationText - Recent conversation text in normalized lower-case form.
 * @returns `true` when the entity is concretely grounded in recent conversation.
 */
function recentConversationAnchorsEntity(
  entityKey: string,
  graph: EntityGraphV1,
  recentConversationText: string
): boolean {
  const normalizedRecentConversationText = recentConversationText.toLowerCase();
  const entity = graph.entities.find((candidate) => candidate.entityKey === entityKey);
  if (!entity) {
    return false;
  }
  const anchorTokens = new Set<string>([
    ...tokenizeEntityAnchor(entity.canonicalName),
    ...entity.aliases.flatMap((alias) => tokenizeEntityAnchor(alias))
  ]);
  if (anchorTokens.size === 0) {
    return false;
  }
  for (const token of anchorTokens) {
    if (normalizedRecentConversationText.includes(token)) {
      return true;
    }
  }
  return false;
}
