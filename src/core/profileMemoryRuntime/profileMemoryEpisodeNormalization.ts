/**
 * @fileoverview Canonical episodic-memory normalization helpers for persisted profile-memory state.
 */

import type { ProfileEpisodeRecord } from "./profileMemoryEpisodeContracts";
import { clampProfileEpisodeConfidence } from "./profileMemoryEpisodeState";

/**
 * Normalizes unknown persisted episode payloads into valid `ProfileEpisodeRecord` values.
 *
 * @param raw - Parsed unknown episode payload.
 * @returns Canonical normalized episodic-memory records.
 */
export function normalizeProfileMemoryEpisodes(raw: unknown): ProfileEpisodeRecord[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((episode): ProfileEpisodeRecord[] => {
    if (!episode || typeof episode !== "object" || Array.isArray(episode)) {
      return [];
    }
    const candidate = episode as Partial<ProfileEpisodeRecord>;
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.title !== "string" ||
      typeof candidate.summary !== "string" ||
      (candidate.status !== "unresolved" &&
        candidate.status !== "partially_resolved" &&
        candidate.status !== "resolved" &&
        candidate.status !== "outcome_unknown" &&
        candidate.status !== "no_longer_relevant") ||
      typeof candidate.sourceTaskId !== "string" ||
      typeof candidate.source !== "string" ||
      (candidate.sourceKind !== "explicit_user_statement" &&
        candidate.sourceKind !== "assistant_inference") ||
      typeof candidate.sensitive !== "boolean"
    ) {
      return [];
    }

    return [{
      id: candidate.id,
      title: candidate.title.trim(),
      summary: candidate.summary.trim(),
      status: candidate.status,
      sourceTaskId: candidate.sourceTaskId,
      source: candidate.source,
      sourceKind: candidate.sourceKind,
      sensitive: candidate.sensitive,
      confidence: clampProfileEpisodeConfidence(candidate.confidence),
      observedAt: toIsoOrNow(candidate.observedAt),
      lastMentionedAt: toIsoOrNow(candidate.lastMentionedAt),
      lastUpdatedAt: toIsoOrNow(candidate.lastUpdatedAt),
      resolvedAt: candidate.resolvedAt ? toIsoOrNow(candidate.resolvedAt) : null,
      entityRefs: normalizeEpisodeStringList(candidate.entityRefs),
      openLoopRefs: normalizeEpisodeStringList(candidate.openLoopRefs),
      tags: normalizeEpisodeStringList(candidate.tags)
    }];
  });
}

/**
 * Normalizes string-list episode fields into trimmed, deduped, sorted collections.
 *
 * @param value - Unknown string-list payload from persisted state.
 * @returns Canonical string list.
 */
function normalizeEpisodeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    normalized.add(trimmed);
  }

  return [...normalized].sort((left, right) => left.localeCompare(right));
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
