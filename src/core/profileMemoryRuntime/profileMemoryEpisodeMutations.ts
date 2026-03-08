/**
 * @fileoverview Deterministic episodic-memory mutation helpers for profile-memory runtime.
 */

import type { ProfileMemoryState } from "../profileMemory";
import type {
  CreateProfileEpisodeRecordInput,
  ProfileEpisodeRecord,
  ProfileEpisodeResolutionInput,
  ProfileEpisodeStatus
} from "./profileMemoryEpisodeContracts";
import {
  clampProfileEpisodeConfidence,
  createProfileEpisodeRecord,
  isTerminalProfileEpisodeStatus
} from "./profileMemoryEpisodeState";
import { normalizeProfileValue } from "./profileMemoryNormalization";

export interface ProfileEpisodeCandidateApplyResult {
  nextState: ProfileMemoryState;
  createdEpisodes: number;
  updatedEpisodes: number;
}

export interface ProfileEpisodeResolutionApplyResult {
  nextState: ProfileMemoryState;
  resolvedEpisodes: number;
}

const TERMINAL_STATUS_WEIGHT: Record<ProfileEpisodeStatus, number> = {
  unresolved: 0,
  outcome_unknown: 1,
  partially_resolved: 2,
  resolved: 3,
  no_longer_relevant: 4
};

/**
 * Applies bounded episode candidates with deterministic upsert/merge semantics.
 *
 * @param state - Loaded profile-memory state.
 * @param candidates - Episode candidates to upsert.
 * @returns Next state plus created/updated counts.
 */
export function applyProfileEpisodeCandidates(
  state: ProfileMemoryState,
  candidates: readonly CreateProfileEpisodeRecordInput[]
): ProfileEpisodeCandidateApplyResult {
  const dedupedCandidates = dedupeEpisodeCandidates(candidates);
  if (dedupedCandidates.length === 0) {
    return {
      nextState: state,
      createdEpisodes: 0,
      updatedEpisodes: 0
    };
  }

  const nextEpisodes = [...state.episodes];
  let createdEpisodes = 0;
  let updatedEpisodes = 0;

  for (const candidate of dedupedCandidates) {
    const candidateEntityRefs = mergeStringLists([], candidate.entityRefs);
    const existingIndex = nextEpisodes.findIndex((episode) =>
      buildEpisodeMatchKey(episode.title, episode.entityRefs) ===
      buildEpisodeMatchKey(candidate.title, candidateEntityRefs)
    );
    if (existingIndex < 0) {
      nextEpisodes.push(createProfileEpisodeRecord(candidate));
      createdEpisodes += 1;
      continue;
    }

    nextEpisodes[existingIndex] = mergeEpisodeRecord(nextEpisodes[existingIndex], candidate);
    updatedEpisodes += 1;
  }

  return {
    nextState: {
      ...state,
      updatedAt: dedupedCandidates[dedupedCandidates.length - 1]?.observedAt ?? state.updatedAt,
      episodes: sortEpisodes(nextEpisodes)
    },
    createdEpisodes,
    updatedEpisodes
  };
}

/**
 * Applies bounded episode-resolution updates to existing episode records.
 *
 * @param state - Loaded profile-memory state.
 * @param resolutions - Episode resolutions to apply.
 * @returns Next state plus resolved count.
 */
export function applyProfileEpisodeResolutions(
  state: ProfileMemoryState,
  resolutions: readonly ProfileEpisodeResolutionInput[]
): ProfileEpisodeResolutionApplyResult {
  if (resolutions.length === 0 || state.episodes.length === 0) {
    return {
      nextState: state,
      resolvedEpisodes: 0
    };
  }

  const dedupedResolutions = dedupeEpisodeResolutions(resolutions);
  const nextEpisodes = [...state.episodes];
  let resolvedEpisodes = 0;

  for (const resolution of dedupedResolutions) {
    const episodeIndex = nextEpisodes.findIndex((episode) => episode.id === resolution.episodeId);
    if (episodeIndex < 0) {
      continue;
    }
    const nextEpisode = applyEpisodeResolution(nextEpisodes[episodeIndex], resolution);
    if (nextEpisode === nextEpisodes[episodeIndex]) {
      continue;
    }
    nextEpisodes[episodeIndex] = nextEpisode;
    resolvedEpisodes += 1;
  }

  if (resolvedEpisodes === 0) {
    return {
      nextState: state,
      resolvedEpisodes: 0
    };
  }

  return {
    nextState: {
      ...state,
      updatedAt: dedupedResolutions[dedupedResolutions.length - 1]?.observedAt ?? state.updatedAt,
      episodes: sortEpisodes(nextEpisodes)
    },
    resolvedEpisodes
  };
}

/**
 * Merges an existing episode record with a new candidate.
 *
 * @param existing - Existing episode record.
 * @param candidate - New candidate to merge.
 * @returns Merged episode record.
 */
function mergeEpisodeRecord(
  existing: ProfileEpisodeRecord,
  candidate: CreateProfileEpisodeRecordInput
): ProfileEpisodeRecord {
  const candidateStatus = candidate.status ?? "unresolved";
  const nextStatus = mergeEpisodeStatus(existing.status, candidateStatus);
  const observedAt = toIsoOrNow(candidate.observedAt);
  const nextSummary = chooseEpisodeSummary(existing.summary, candidate.summary);
  const nextResolvedAt =
    isTerminalProfileEpisodeStatus(nextStatus)
      ? (candidate.resolvedAt ? toIsoOrNow(candidate.resolvedAt) : existing.resolvedAt ?? observedAt)
      : null;

  return {
    ...existing,
    title: normalizeProfileValue(candidate.title),
    summary: nextSummary,
    status: nextStatus,
    sourceTaskId: candidate.sourceTaskId,
    source: candidate.source,
    sourceKind: candidate.sourceKind,
    sensitive: existing.sensitive || candidate.sensitive,
    confidence: Math.max(existing.confidence, clampProfileEpisodeConfidence(candidate.confidence)),
    lastMentionedAt: maxIso(existing.lastMentionedAt, observedAt),
    lastUpdatedAt: observedAt,
    resolvedAt: nextResolvedAt,
    entityRefs: mergeStringLists(existing.entityRefs, candidate.entityRefs),
    openLoopRefs: mergeStringLists(existing.openLoopRefs, candidate.openLoopRefs),
    tags: mergeStringLists(existing.tags, candidate.tags)
  };
}

/**
 * Applies one resolution update to one existing episode record.
 *
 * @param episode - Existing episode record.
 * @param resolution - Resolution payload to apply.
 * @returns Updated episode record, or the same record when no change is needed.
 */
function applyEpisodeResolution(
  episode: ProfileEpisodeRecord,
  resolution: ProfileEpisodeResolutionInput
): ProfileEpisodeRecord {
  const observedAt = toIsoOrNow(resolution.observedAt);
  const nextStatus = mergeEpisodeStatus(episode.status, resolution.status);
  const nextSummary = resolution.summary
    ? chooseEpisodeSummary(episode.summary, resolution.summary)
    : episode.summary;
  const nextConfidence = Math.max(
    episode.confidence,
    clampProfileEpisodeConfidence(resolution.confidence)
  );
  const nextResolvedAt = isTerminalProfileEpisodeStatus(nextStatus)
    ? (episode.resolvedAt ?? observedAt)
    : episode.resolvedAt;

  const nextEpisode: ProfileEpisodeRecord = {
    ...episode,
    status: nextStatus,
    summary: nextSummary,
    sourceTaskId: resolution.sourceTaskId,
    source: resolution.source,
    confidence: nextConfidence,
    lastMentionedAt: maxIso(episode.lastMentionedAt, observedAt),
    lastUpdatedAt: observedAt,
    resolvedAt: nextResolvedAt,
    entityRefs: mergeStringLists(episode.entityRefs, resolution.entityRefs),
    openLoopRefs: mergeStringLists(episode.openLoopRefs, resolution.openLoopRefs),
    tags: mergeStringLists(episode.tags, resolution.tags)
  };

  return JSON.stringify(nextEpisode) === JSON.stringify(episode)
    ? episode
    : nextEpisode;
}

/**
 * Deduplicates normalized episode candidates before mutation.
 *
 * @param candidates - Raw episode candidates.
 * @returns Deduplicated normalized episode candidates.
 */
function dedupeEpisodeCandidates(
  candidates: readonly CreateProfileEpisodeRecordInput[]
): CreateProfileEpisodeRecordInput[] {
  const deduped: CreateProfileEpisodeRecordInput[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeEpisodeCandidate(candidate);
    if (!normalizedCandidate) {
      continue;
    }
    const signature = buildEpisodeMatchKey(
      normalizedCandidate.title,
      mergeStringLists([], normalizedCandidate.entityRefs)
    );
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    deduped.push(normalizedCandidate);
  }

  return deduped;
}

/**
 * Deduplicates resolution updates by episode id.
 *
 * @param resolutions - Raw resolution payloads.
 * @returns Deduplicated resolution payloads.
 */
function dedupeEpisodeResolutions(
  resolutions: readonly ProfileEpisodeResolutionInput[]
): ProfileEpisodeResolutionInput[] {
  const deduped = new Map<string, ProfileEpisodeResolutionInput>();
  for (const resolution of resolutions) {
    if (!resolution.episodeId.trim()) {
      continue;
    }
    const existing = deduped.get(resolution.episodeId);
    if (!existing) {
      deduped.set(resolution.episodeId, resolution);
      continue;
    }
    if (TERMINAL_STATUS_WEIGHT[resolution.status] >= TERMINAL_STATUS_WEIGHT[existing.status]) {
      deduped.set(resolution.episodeId, resolution);
    }
  }

  return [...deduped.values()];
}

/**
 * Normalizes one episode candidate into a canonical shape suitable for storage.
 *
 * @param candidate - Raw episode candidate.
 * @returns Normalized candidate, or `null` when invalid.
 */
function normalizeEpisodeCandidate(
  candidate: CreateProfileEpisodeRecordInput
): CreateProfileEpisodeRecordInput | null {
  const title = normalizeProfileValue(candidate.title);
  const summary = normalizeProfileValue(candidate.summary);
  const entityRefs = mergeStringLists([], candidate.entityRefs);
  if (!title || !summary || entityRefs.length === 0) {
    return null;
  }

  return {
    ...candidate,
    title,
    summary,
    observedAt: toIsoOrNow(candidate.observedAt),
    entityRefs,
    openLoopRefs: mergeStringLists([], candidate.openLoopRefs),
    tags: mergeStringLists([], candidate.tags)
  };
}

/**
 * Builds a deterministic match key for one episode candidate or record.
 *
 * @param title - Episode title.
 * @param entityRefs - Canonical entity refs.
 * @returns Stable match key.
 */
function buildEpisodeMatchKey(
  title: string,
  entityRefs: readonly string[]
): string {
  const normalizedTitle = normalizeProfileValue(title).toLowerCase();
  return `${entityRefs.join("|")}::${normalizedTitle}`;
}

/**
 * Merges two episode statuses without downgrading a more terminal state.
 *
 * @param existing - Existing episode status.
 * @param incoming - Incoming episode status.
 * @returns Merged episode status.
 */
function mergeEpisodeStatus(
  existing: ProfileEpisodeStatus,
  incoming: ProfileEpisodeStatus
): ProfileEpisodeStatus {
  return TERMINAL_STATUS_WEIGHT[incoming] >= TERMINAL_STATUS_WEIGHT[existing]
    ? incoming
    : existing;
}

/**
 * Chooses the better episode summary between an existing and incoming value.
 *
 * @param existing - Existing summary.
 * @param incoming - Incoming summary.
 * @returns Preferred summary text.
 */
function chooseEpisodeSummary(existing: string, incoming: string): string {
  const normalizedExisting = normalizeProfileValue(existing);
  const normalizedIncoming = normalizeProfileValue(incoming);
  if (!normalizedIncoming) {
    return normalizedExisting;
  }
  if (!normalizedExisting) {
    return normalizedIncoming;
  }
  return normalizedIncoming.length >= normalizedExisting.length
    ? normalizedIncoming
    : normalizedExisting;
}

/**
 * Merges string lists into a trimmed, deduplicated, sorted collection.
 *
 * @param left - Existing values.
 * @param right - Incoming values.
 * @returns Canonical merged string list.
 */
function mergeStringLists(
  left: readonly string[],
  right: readonly string[] | undefined
): string[] {
  const merged = new Set<string>();
  for (const value of [...left, ...(right ?? [])]) {
    if (typeof value !== "string") {
      continue;
    }
    const normalized = normalizeProfileValue(value);
    if (!normalized) {
      continue;
    }
    merged.add(normalized);
  }
  return [...merged].sort((first, second) => first.localeCompare(second));
}

/**
 * Returns the later valid ISO timestamp from two candidates.
 *
 * @param left - Existing ISO timestamp.
 * @param right - Incoming ISO timestamp.
 * @returns Later valid ISO timestamp.
 */
function maxIso(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

/**
 * Coerces a timestamp candidate to valid ISO format, falling back to `now`.
 *
 * @param value - Candidate timestamp value.
 * @returns Valid ISO timestamp string.
 */
function toIsoOrNow(value: string | undefined): string {
  if (typeof value !== "string") {
    return new Date().toISOString();
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return new Date().toISOString();
  }
  return new Date(parsed).toISOString();
}

/**
 * Sorts episode records deterministically for persistence.
 *
 * @param episodes - Episode collection to sort.
 * @returns Sorted episode records.
 */
function sortEpisodes(episodes: readonly ProfileEpisodeRecord[]): ProfileEpisodeRecord[] {
  return [...episodes].sort((left, right) => {
    if (left.lastMentionedAt !== right.lastMentionedAt) {
      return right.lastMentionedAt.localeCompare(left.lastMentionedAt);
    }
    return left.id.localeCompare(right.id);
  });
}
