/**
 * @fileoverview Approval-aware episode reads and continuity-aware episodic-memory queries.
 */

import type {
  ConversationStackV1,
  EntityGraphV1
} from "../types";
import type { ProfileMemoryState } from "../profileMemory";
import type {
  ProfileAccessRequest,
  ProfileReadableEpisode
} from "./contracts";
import { isTerminalProfileEpisodeStatus } from "./profileMemoryEpisodeState";
import { compareProfileEpisodesForLifecyclePriority } from "./profileMemoryEpisodeConsolidation";
import {
  linkProfileEpisodesToContinuity,
  type LinkedProfileEpisodeRecord
} from "./profileMemoryEpisodeLinking";

export interface ProfileEpisodeContinuityQueryRequest {
  entityHints: readonly string[];
  maxEpisodes?: number;
  includeResolved?: boolean;
}

/**
 * Evaluates whether a profile access request includes explicit human approval metadata.
 *
 * @param request - Access request under evaluation.
 * @returns `true` when the request includes explicit approval.
 */
function isApprovalValid(request: ProfileAccessRequest): boolean {
  return (
    request.explicitHumanApproval === true &&
    typeof request.approvalId === "string" &&
    request.approvalId.trim().length > 0
  );
}

/**
 * Evaluates whether sensitive profile episodes may be returned for this request.
 *
 * @param request - Access request under evaluation.
 * @returns `true` when sensitive episodes may be shown.
 */
function canReadSensitiveEpisodes(request: ProfileAccessRequest): boolean {
  if (!request.includeSensitive) {
    return false;
  }
  if (request.purpose !== "operator_view") {
    return false;
  }
  return isApprovalValid(request);
}

/**
 * Returns readable episodic-memory records under approval-aware sensitivity gating.
 *
 * @param state - Loaded profile-memory state.
 * @param request - Access request with sensitivity and count controls.
 * @returns Sorted readable episode entries filtered by sensitivity policy.
 */
export function readProfileEpisodes(
  state: ProfileMemoryState,
  request: ProfileAccessRequest,
  nowIso = state.updatedAt,
  staleAfterDays = 90
): ProfileReadableEpisode[] {
  const sensitiveAllowed = canReadSensitiveEpisodes(request);
  const maxEpisodes = Math.max(1, request.maxEpisodes ?? 10);
  return [...state.episodes]
    .sort((left, right) =>
      compareProfileEpisodesForLifecyclePriority(left, right, staleAfterDays, nowIso)
    )
    .filter((episode) => sensitiveAllowed || !episode.sensitive)
    .slice(0, maxEpisodes)
    .map((episode) => ({
      episodeId: episode.id,
      title: episode.title,
      summary: episode.summary,
      status: episode.status,
      sensitive: episode.sensitive,
      sourceKind: episode.sourceKind,
      observedAt: episode.observedAt,
      lastMentionedAt: episode.lastMentionedAt,
      lastUpdatedAt: episode.lastUpdatedAt,
      resolvedAt: episode.resolvedAt,
      confidence: episode.confidence,
      entityRefs: [...episode.entityRefs],
      openLoopRefs: [...episode.openLoopRefs],
      tags: [...episode.tags]
    }));
}

/**
 * Tokenizes hint text into deterministic lower-case comparison terms.
 *
 * @param value - Freeform value to tokenize.
 * @returns Stable list of meaningful terms.
 */
function tokenizeHintTerms(value: string): readonly string[] {
  const matches = value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return [...new Set(matches.filter((entry) => entry.trim().length >= 3))].sort();
}

/**
 * Counts deterministic overlap between hint terms and linked episode surfaces.
 *
 * @param hintTerms - Current entity-hint terms.
 * @param linkedEpisode - Linked episode candidate.
 * @returns Overlap count.
 */
function countHintOverlap(
  hintTerms: readonly string[],
  linkedEpisode: LinkedProfileEpisodeRecord
): number {
  const surfaceTerms = new Set<string>();
  for (const value of [
    linkedEpisode.episode.title,
    linkedEpisode.episode.summary,
    ...linkedEpisode.episode.entityRefs,
    ...linkedEpisode.entityLinks.map((entry) => entry.canonicalName),
    ...linkedEpisode.openLoopLinks.map((entry) => entry.threadKey)
  ]) {
    for (const term of tokenizeHintTerms(value)) {
      surfaceTerms.add(term);
    }
  }

  let overlap = 0;
  for (const hint of hintTerms) {
    if (surfaceTerms.has(hint)) {
      overlap += 1;
    }
  }
  return overlap;
}

/**
 * Selects bounded episodic-memory records for a re-mentioned entity/topic.
 *
 * @param state - Loaded profile-memory state.
 * @param graph - Current Stage 6.86 entity graph.
 * @param stack - Current Stage 6.86 conversation stack.
 * @param request - Entity-hint query request.
 * @returns Deterministically ranked linked episodic-memory records.
 */
export function queryProfileEpisodesForContinuity(
  state: ProfileMemoryState,
  graph: EntityGraphV1,
  stack: ConversationStackV1,
  request: ProfileEpisodeContinuityQueryRequest,
  nowIso = state.updatedAt,
  staleAfterDays = 90
): readonly LinkedProfileEpisodeRecord[] {
  const hintTerms = tokenizeHintTerms(request.entityHints.join(" "));
  if (hintTerms.length === 0) {
    return [];
  }

  const maxEpisodes = Math.max(1, request.maxEpisodes ?? 3);
  return linkProfileEpisodesToContinuity(state.episodes, graph, stack)
    .filter((entry) => request.includeResolved === true || !isTerminalProfileEpisodeStatus(entry.episode.status))
    .map((entry) => ({
      entry,
      hintOverlap: countHintOverlap(hintTerms, entry)
    }))
    .filter(({ entry, hintOverlap }) =>
      hintOverlap > 0 &&
      (entry.entityLinks.length > 0 || entry.openLoopLinks.length > 0)
    )
    .sort((left, right) => {
      if (left.hintOverlap !== right.hintOverlap) {
        return right.hintOverlap - left.hintOverlap;
      }
      const leftLinkCount = left.entry.entityLinks.length + left.entry.openLoopLinks.length;
      const rightLinkCount = right.entry.entityLinks.length + right.entry.openLoopLinks.length;
      if (leftLinkCount !== rightLinkCount) {
        return rightLinkCount - leftLinkCount;
      }
      return compareProfileEpisodesForLifecyclePriority(
        left.entry.episode,
        right.entry.episode,
        staleAfterDays,
        nowIso
      );
    })
    .slice(0, maxEpisodes)
    .map(({ entry }) => entry);
}
