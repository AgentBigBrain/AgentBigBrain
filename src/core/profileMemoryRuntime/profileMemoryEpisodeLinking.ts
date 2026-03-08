/**
 * @fileoverview Deterministic linkage helpers between episodic memory and Stage 6.86 continuity state.
 */

import type {
  ConversationStackV1,
  EntityGraphV1,
  OpenLoopV1
} from "../types";
import { countLanguageTermOverlap } from "../languageRuntime/languageScoring";
import { extractEpisodeLinkingTerms } from "../languageRuntime/queryIntentTerms";
import type { ProfileEpisodeRecord } from "./profileMemoryEpisodeContracts";
import { getEntityLookupTerms } from "../stage6_86/entityGraph";
import { getOpenLoopLookupTermsV1 } from "../stage6_86/openLoops";

export type ProfileEpisodeEntityLinkReason =
  | "entity_ref_overlap"
  | "title_summary_overlap";

export type ProfileEpisodeOpenLoopLinkReason =
  | "entity_ref_overlap"
  | "topic_overlap";

export interface ProfileEpisodeEntityLink {
  entityKey: string;
  canonicalName: string;
  reason: ProfileEpisodeEntityLinkReason;
}

export interface ProfileEpisodeOpenLoopLink {
  loopId: string;
  threadKey: string;
  status: OpenLoopV1["status"];
  priority: number;
  reason: ProfileEpisodeOpenLoopLinkReason;
}

export interface LinkedProfileEpisodeRecord {
  episode: ProfileEpisodeRecord;
  entityLinks: readonly ProfileEpisodeEntityLink[];
  openLoopLinks: readonly ProfileEpisodeOpenLoopLink[];
}

/**
 * Tokenizes freeform text or ref strings into deterministic lower-case terms.
 *
 * @param value - Freeform value to normalize.
 * @returns Stable list of meaningful terms.
 */
function tokenizeTerms(value: string): readonly string[] {
  return [...extractEpisodeLinkingTerms(value)].sort((left, right) => left.localeCompare(right));
}

/**
 * Builds the deterministic term set for one episode.
 *
 * @param episode - Episode record to normalize.
 * @returns Stable set of episode lookup terms.
 */
function buildEpisodeTerms(episode: ProfileEpisodeRecord): readonly string[] {
  const terms = new Set<string>();
  for (const value of [
    episode.title,
    episode.summary,
    ...episode.entityRefs,
    ...episode.tags
  ]) {
    for (const term of tokenizeTerms(value)) {
      terms.add(term);
    }
  }
  return [...terms].sort((left, right) => left.localeCompare(right));
}

/**
 * Counts deterministic term overlap between two term sets.
 *
 * @param left - Left-side terms.
 * @param right - Right-side terms.
 * @returns Overlap count.
 */
function countOverlap(left: readonly string[], right: readonly string[]): number {
  return countLanguageTermOverlap(left, right);
}

/**
 * Builds deterministic entity links for one episode against the current graph.
 *
 * @param episode - Episode under evaluation.
 * @param graph - Current continuity entity graph.
 * @returns Deterministic entity links.
 */
function buildEpisodeEntityLinks(
  episode: ProfileEpisodeRecord,
  graph: EntityGraphV1
): readonly ProfileEpisodeEntityLink[] {
  const entityRefTerms = tokenizeTerms(episode.entityRefs.join(" "));
  const episodeTerms = buildEpisodeTerms(episode);
  const links: ProfileEpisodeEntityLink[] = [];

  for (const entity of graph.entities) {
    const entityTerms = getEntityLookupTerms(entity);
    const refOverlap = countOverlap(entityRefTerms, entityTerms);
    const episodeOverlap = countOverlap(episodeTerms, entityTerms);
    if (refOverlap === 0 && episodeOverlap === 0) {
      continue;
    }
    links.push({
      entityKey: entity.entityKey,
      canonicalName: entity.canonicalName,
      reason: refOverlap > 0 ? "entity_ref_overlap" : "title_summary_overlap"
    });
  }

  return links.sort((left, right) => {
    if (left.entityKey !== right.entityKey) {
      return left.entityKey.localeCompare(right.entityKey);
    }
    return left.reason.localeCompare(right.reason);
  });
}

/**
 * Builds deterministic open-loop links for one episode against the current conversation stack.
 *
 * @param episode - Episode under evaluation.
 * @param stack - Current conversation continuity stack.
 * @returns Deterministic open-loop links.
 */
function buildEpisodeOpenLoopLinks(
  episode: ProfileEpisodeRecord,
  stack: ConversationStackV1
): readonly ProfileEpisodeOpenLoopLink[] {
  const entityRefTerms = tokenizeTerms(episode.entityRefs.join(" "));
  const episodeTerms = buildEpisodeTerms(episode);
  const links: ProfileEpisodeOpenLoopLink[] = [];

  for (const thread of stack.threads) {
    for (const loop of thread.openLoops) {
      const loopTerms = getOpenLoopLookupTermsV1(loop, thread);
      const refOverlap = countOverlap(entityRefTerms, loopTerms);
      const topicOverlap = countOverlap(episodeTerms, loopTerms);
      if (refOverlap === 0 && topicOverlap === 0) {
        continue;
      }
      links.push({
        loopId: loop.loopId,
        threadKey: thread.threadKey,
        status: loop.status,
        priority: loop.priority,
        reason: refOverlap > 0 ? "entity_ref_overlap" : "topic_overlap"
      });
    }
  }

  return links.sort((left, right) => {
    if (left.loopId !== right.loopId) {
      return left.loopId.localeCompare(right.loopId);
    }
    return left.reason.localeCompare(right.reason);
  });
}

/**
 * Links one episode to the current Stage 6.86 continuity surfaces.
 *
 * @param episode - Episode under evaluation.
 * @param graph - Current continuity entity graph.
 * @param stack - Current continuity conversation stack.
 * @returns Linked episode record with deterministic entity/open-loop links.
 */
export function linkProfileEpisodeToContinuity(
  episode: ProfileEpisodeRecord,
  graph: EntityGraphV1,
  stack: ConversationStackV1
): LinkedProfileEpisodeRecord {
  return {
    episode,
    entityLinks: buildEpisodeEntityLinks(episode, graph),
    openLoopLinks: buildEpisodeOpenLoopLinks(episode, stack)
  };
}

/**
 * Links all episodic-memory records to the current Stage 6.86 continuity surfaces.
 *
 * @param episodes - Episodes to link.
 * @param graph - Current continuity entity graph.
 * @param stack - Current continuity conversation stack.
 * @returns Deterministically ordered linked episode records.
 */
export function linkProfileEpisodesToContinuity(
  episodes: readonly ProfileEpisodeRecord[],
  graph: EntityGraphV1,
  stack: ConversationStackV1
): readonly LinkedProfileEpisodeRecord[] {
  return episodes
    .map((episode) => linkProfileEpisodeToContinuity(episode, graph, stack))
    .sort((left, right) => left.episode.id.localeCompare(right.episode.id));
}
