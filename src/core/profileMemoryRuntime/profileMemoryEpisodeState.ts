/**
 * @fileoverview Canonical episodic-memory state helpers for profile-memory runtime.
 */

import { makeId } from "../ids";
import type {
  CreateProfileEpisodeRecordInput,
  ProfileEpisodeRecord,
  ProfileEpisodeStatus
} from "./profileMemoryEpisodeContracts";

export const PROFILE_MEMORY_EPISODE_SCHEMA_VERSION = 1;

/**
 * Clamps episodic-memory confidence to the deterministic 0-1 range.
 *
 * @param value - Candidate confidence value.
 * @returns Normalized confidence rounded to four decimals.
 */
export function clampProfileEpisodeConfidence(value: number | undefined): number {
  if (!Number.isFinite(value ?? Number.NaN)) {
    return 0.5;
  }
  return Number(Math.min(1, Math.max(0, value as number)).toFixed(4));
}

/**
 * Returns whether an episode status is terminal for recall/revisit purposes.
 *
 * @param status - Episodic-memory status to inspect.
 * @returns `true` when the status is terminal.
 */
export function isTerminalProfileEpisodeStatus(status: ProfileEpisodeStatus): boolean {
  return status === "resolved" || status === "no_longer_relevant";
}

/**
 * Builds one canonical episodic-memory record from bounded typed input.
 *
 * @param input - Source fields for the new episode record.
 * @returns Canonical episodic-memory record.
 */
export function createProfileEpisodeRecord(
  input: CreateProfileEpisodeRecordInput
): ProfileEpisodeRecord {
  const observedAt = toIsoOrNow(input.observedAt);
  return {
    id: makeId("episode"),
    title: input.title.trim(),
    summary: input.summary.trim(),
    status: input.status ?? "unresolved",
    sourceTaskId: input.sourceTaskId,
    source: input.source,
    sourceKind: input.sourceKind,
    sensitive: input.sensitive,
    confidence: clampProfileEpisodeConfidence(input.confidence),
    observedAt,
    lastMentionedAt: toIsoOrNow(input.lastMentionedAt ?? observedAt),
    lastUpdatedAt: toIsoOrNow(input.lastUpdatedAt ?? observedAt),
    resolvedAt: input.resolvedAt ? toIsoOrNow(input.resolvedAt) : null,
    entityRefs: normalizeStringList(input.entityRefs),
    openLoopRefs: normalizeStringList(input.openLoopRefs),
    tags: normalizeStringList(input.tags)
  };
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
 * Normalizes an optional string list into a trimmed, deduped, sorted collection.
 *
 * @param values - Optional string-list payload.
 * @returns Canonical string collection.
 */
function normalizeStringList(values: readonly string[] | undefined): string[] {
  if (!values) {
    return [];
  }
  const normalized = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    normalized.add(trimmed);
  }
  return [...normalized].sort((left, right) => left.localeCompare(right));
}
