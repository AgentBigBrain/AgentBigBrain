/**
 * @fileoverview Episodic-memory consolidation and lifecycle-priority helpers.
 */

import type { ProfileEpisodeRecord } from "./profileMemoryEpisodeContracts";
import { isTerminalProfileEpisodeStatus } from "./profileMemoryEpisodeState";
import { normalizeProfileValue } from "./profileMemoryNormalization";

export interface ProfileEpisodeFreshnessAssessment {
  stale: boolean;
  ageDays: number;
}

export interface ProfileEpisodeConsolidationResult {
  episodes: ProfileEpisodeRecord[];
  consolidatedEpisodeCount: number;
}

const EPISODE_STATUS_PRIORITY: Record<ProfileEpisodeRecord["status"], number> = {
  unresolved: 5,
  partially_resolved: 4,
  outcome_unknown: 3,
  resolved: 2,
  no_longer_relevant: 1
};

/**
 * Builds one deterministic consolidation key for episodic-memory dedupe decisions.
 *
 * @param episode - Episode record under evaluation.
 * @returns Stable dedupe key.
 */
export function buildProfileEpisodeConsolidationKey(
  episode: Pick<ProfileEpisodeRecord, "title" | "entityRefs">
): string {
  const normalizedTitle = normalizeProfileValue(episode.title).toLowerCase();
  const entityRefs = normalizeStringList(episode.entityRefs);
  return `${entityRefs.join("|")}::${normalizedTitle}`;
}

/**
 * Assesses whether an episode has gone stale for recall/pulse ranking purposes.
 *
 * @param episode - Episode record under evaluation.
 * @param staleAfterDays - Staleness window in days.
 * @param nowIso - Current evaluation timestamp.
 * @returns Deterministic freshness assessment.
 */
export function assessProfileEpisodeFreshness(
  episode: Pick<ProfileEpisodeRecord, "lastMentionedAt">,
  staleAfterDays: number,
  nowIso: string
): ProfileEpisodeFreshnessAssessment {
  const nowMs = Date.parse(nowIso);
  const lastMentionedMs = Date.parse(episode.lastMentionedAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(lastMentionedMs)) {
    return {
      stale: false,
      ageDays: 0
    };
  }

  const ageDays = Math.max(0, Math.floor((nowMs - lastMentionedMs) / 86_400_000));
  return {
    stale: ageDays >= Math.max(1, Math.floor(staleAfterDays)),
    ageDays
  };
}

/**
 * Compares two episodes for recall/pulse usefulness.
 *
 * @param left - First episode.
 * @param right - Second episode.
 * @param staleAfterDays - Staleness window in days.
 * @param nowIso - Current evaluation timestamp.
 * @returns Sort order where lower values are higher priority.
 */
export function compareProfileEpisodesForLifecyclePriority(
  left: ProfileEpisodeRecord,
  right: ProfileEpisodeRecord,
  staleAfterDays: number,
  nowIso: string
): number {
  const leftTerminal = isTerminalProfileEpisodeStatus(left.status);
  const rightTerminal = isTerminalProfileEpisodeStatus(right.status);
  if (leftTerminal !== rightTerminal) {
    return leftTerminal ? 1 : -1;
  }

  const leftFreshness = assessProfileEpisodeFreshness(left, staleAfterDays, nowIso);
  const rightFreshness = assessProfileEpisodeFreshness(right, staleAfterDays, nowIso);
  if (leftFreshness.stale !== rightFreshness.stale) {
    return leftFreshness.stale ? 1 : -1;
  }

  const leftStatusPriority = EPISODE_STATUS_PRIORITY[left.status];
  const rightStatusPriority = EPISODE_STATUS_PRIORITY[right.status];
  if (leftStatusPriority !== rightStatusPriority) {
    return rightStatusPriority - leftStatusPriority;
  }

  if (left.lastMentionedAt !== right.lastMentionedAt) {
    return right.lastMentionedAt.localeCompare(left.lastMentionedAt);
  }

  if (left.lastUpdatedAt !== right.lastUpdatedAt) {
    return right.lastUpdatedAt.localeCompare(left.lastUpdatedAt);
  }

  return left.id.localeCompare(right.id);
}

/**
 * Consolidates duplicate episodic-memory records created for the same entity/situation key.
 *
 * @param episodes - Episode records to normalize.
 * @returns Consolidated episode collection and duplicate count.
 */
export function consolidateProfileEpisodes(
  episodes: readonly ProfileEpisodeRecord[]
): ProfileEpisodeConsolidationResult {
  if (episodes.length <= 1) {
    return {
      episodes: [...episodes],
      consolidatedEpisodeCount: 0
    };
  }

  const byKey = new Map<string, ProfileEpisodeRecord>();
  let consolidatedEpisodeCount = 0;

  for (const episode of episodes) {
    const key = buildProfileEpisodeConsolidationKey(episode);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, episode);
      continue;
    }
    byKey.set(key, mergeConsolidatedEpisodeRecords(existing, episode));
    consolidatedEpisodeCount += 1;
  }

  return {
    episodes: [...byKey.values()].sort((left, right) => {
      if (left.lastMentionedAt !== right.lastMentionedAt) {
        return right.lastMentionedAt.localeCompare(left.lastMentionedAt);
      }
      return left.id.localeCompare(right.id);
    }),
    consolidatedEpisodeCount
  };
}

/**
 * Merges two duplicate episode records into one deterministic record.
 *
 * @param left - Existing retained record.
 * @param right - Duplicate record under consolidation.
 * @returns Canonical merged episode record.
 */
function mergeConsolidatedEpisodeRecords(
  left: ProfileEpisodeRecord,
  right: ProfileEpisodeRecord
): ProfileEpisodeRecord {
  const laterRecord =
    Date.parse(left.lastUpdatedAt) >= Date.parse(right.lastUpdatedAt) ? left : right;
  const nextStatus =
    EPISODE_STATUS_PRIORITY[left.status] >= EPISODE_STATUS_PRIORITY[right.status]
      ? left.status
      : right.status;
  const nextResolvedAt = isTerminalProfileEpisodeStatus(nextStatus)
    ? latestNonNullIso(left.resolvedAt, right.resolvedAt, laterRecord.lastUpdatedAt)
    : null;

  return {
    ...laterRecord,
    title: chooseLongerValue(left.title, right.title),
    summary: chooseLongerValue(left.summary, right.summary),
    status: nextStatus,
    sourceTaskId: laterRecord.sourceTaskId,
    source: laterRecord.source,
    sourceKind: laterRecord.sourceKind,
    sensitive: left.sensitive || right.sensitive,
    confidence: Math.max(left.confidence, right.confidence),
    observedAt: earlierIso(left.observedAt, right.observedAt),
    lastMentionedAt: laterIso(left.lastMentionedAt, right.lastMentionedAt),
    lastUpdatedAt: laterIso(left.lastUpdatedAt, right.lastUpdatedAt),
    resolvedAt: nextResolvedAt,
    entityRefs: normalizeStringList([...left.entityRefs, ...right.entityRefs]),
    openLoopRefs: normalizeStringList([...left.openLoopRefs, ...right.openLoopRefs]),
    tags: normalizeStringList([...left.tags, ...right.tags])
  };
}

/**
 * Chooses the longer normalized value when both are present.
 *
 * @param left - Existing value.
 * @param right - Incoming value.
 * @returns Preferred normalized value.
 */
function chooseLongerValue(left: string, right: string): string {
  const normalizedLeft = normalizeProfileValue(left);
  const normalizedRight = normalizeProfileValue(right);
  if (!normalizedLeft) {
    return normalizedRight;
  }
  if (!normalizedRight) {
    return normalizedLeft;
  }
  return normalizedRight.length >= normalizedLeft.length ? normalizedRight : normalizedLeft;
}

/**
 * Normalizes a string list into a trimmed, deduplicated, sorted array.
 *
 * @param values - Candidate string collection.
 * @returns Canonical string array.
 */
function normalizeStringList(values: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const value of values) {
    const next = normalizeProfileValue(value);
    if (!next) {
      continue;
    }
    normalized.add(next);
  }
  return [...normalized].sort((left, right) => left.localeCompare(right));
}

/**
 * Returns the earlier valid ISO timestamp from two inputs.
 *
 * @param left - First timestamp.
 * @param right - Second timestamp.
 * @returns Earlier ISO timestamp.
 */
function earlierIso(left: string, right: string): string {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

/**
 * Returns the later valid ISO timestamp from two inputs.
 *
 * @param left - First timestamp.
 * @param right - Second timestamp.
 * @returns Later ISO timestamp.
 */
function laterIso(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

/**
 * Returns the latest non-null ISO timestamp, falling back to the provided default.
 *
 * @param left - First optional timestamp.
 * @param right - Second optional timestamp.
 * @param fallback - Fallback timestamp when both inputs are null.
 * @returns Latest non-null ISO timestamp.
 */
function latestNonNullIso(
  left: string | null,
  right: string | null,
  fallback: string
): string {
  if (left && right) {
    return laterIso(left, right);
  }
  return left ?? right ?? fallback;
}
