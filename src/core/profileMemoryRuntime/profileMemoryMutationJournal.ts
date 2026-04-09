/**
 * @fileoverview Canonical mutation-journal helpers for graph-backed profile-memory persistence.
 */

import type { ProfileMemoryGraphCompactionStateV1, ProfileMemoryMutationJournalEntryV1, ProfileMemoryMutationJournalStateV1 } from "./profileMemoryGraphContracts";
import { buildProfileMemoryMutationJournalCanonicalEntryId, buildProfileMemoryMutationJournalEntryId } from "./profileMemoryMutationJournalIdentitySupport";
import {
  normalizeJournalRedactionStateCandidate,
  normalizeOptionalMetadataString,
  normalizeRecordedAtForComparison,
  normalizeRequiredMetadataString,
  normalizeRequiredRecordedAt
} from "./profileMemoryMutationJournalNormalizationSupport";

/**
 * Creates one empty mutation-journal state envelope.
 *
 * @returns Empty bounded journal state with the first available watermark.
 */
export function createEmptyProfileMemoryMutationJournalState(): ProfileMemoryMutationJournalStateV1 {
  return {
    schemaVersion: "v1",
    nextWatermark: 1,
    entries: []
  };
}

/**
 * Normalizes unknown persisted journal payloads into one stable journal state.
 *
 * @param raw - Unknown persisted journal payload.
 * @returns Stable mutation-journal state.
 */
export function normalizeProfileMemoryMutationJournalState(
  raw: unknown,
  fallbackRecordedAt: string
): ProfileMemoryMutationJournalStateV1 {
  const empty = createEmptyProfileMemoryMutationJournalState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return empty;
  }
  const candidate = raw as Partial<ProfileMemoryMutationJournalStateV1>;
  const normalizedEntries = Array.isArray(candidate.entries)
    ? candidate.entries.flatMap((entry): NormalizedJournalEntryCandidate[] => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return [];
      }
      const typedEntry = entry as Partial<ProfileMemoryMutationJournalEntryV1>;
      const recordedAt = normalizeRequiredRecordedAt(
        typedEntry.recordedAt,
        fallbackRecordedAt
      );
      const redactionState = typedEntry.redactionState == null
        ? "not_requested"
        : normalizeJournalRedactionStateCandidate(typedEntry.redactionState);
      const sourceTaskId = normalizeOptionalMetadataString(typedEntry.sourceTaskId ?? null);
      const sourceFingerprint = normalizeOptionalMetadataString(typedEntry.sourceFingerprint ?? null);
      const mutationEnvelopeHash = normalizeOptionalMetadataString(typedEntry.mutationEnvelopeHash ?? null);
      const observationIds = dedupeSortedStrings(
        Array.isArray(typedEntry.observationIds) ? typedEntry.observationIds : []
      );
      const claimIds = dedupeSortedStrings(
        Array.isArray(typedEntry.claimIds) ? typedEntry.claimIds : []
      );
      const eventIds = dedupeSortedStrings(
        Array.isArray(typedEntry.eventIds) ? typedEntry.eventIds : []
      );
      const recoveredJournalEntryId = buildProfileMemoryMutationJournalEntryId({
        recordedAt,
        sourceTaskId,
        sourceFingerprint,
        mutationEnvelopeHash,
        observationIds,
        claimIds,
        eventIds,
        redactionState: redactionState ?? "not_requested"
      });
      const journalEntryId =
        normalizeRequiredMetadataString(typedEntry.journalEntryId) ?? recoveredJournalEntryId;
      const watermarkRecovered = !isPositiveInteger(typedEntry.watermark);
      const watermark = watermarkRecovered ? 0 : typedEntry.watermark!;
      if (
        redactionState === null
      ) {
        return [];
      }
      return [{
        entry: {
          journalEntryId,
          watermark,
          recordedAt,
          sourceTaskId,
          sourceFingerprint,
          mutationEnvelopeHash,
          observationIds,
          claimIds,
          eventIds,
          redactionState
        },
        watermarkRecovered
      }];
    })
    : [];
  const entries = normalizeJournalEntries(normalizedEntries);
  const highestWatermark = entries.reduce(
    (highest, entry) => Math.max(highest, entry.watermark),
    0
  );
  const nextWatermark = isPositiveInteger(candidate.nextWatermark) &&
      candidate.nextWatermark > highestWatermark
    ? candidate.nextWatermark
    : highestWatermark + 1;
  return {
    schemaVersion: "v1",
    nextWatermark,
    entries
  };
}

/**
 * Appends one deterministic mutation-journal entry when the current graph batch touched canonical
 * graph-backed records.
 *
 * @param state - Existing bounded mutation-journal state.
 * @param input - Deterministic journal-entry payload.
 * @returns Updated journal state plus append metadata.
 */
export function appendProfileMemoryMutationJournalEntry(
  state: ProfileMemoryMutationJournalStateV1,
  input: {
    recordedAt: string;
    sourceTaskId: string | null;
    sourceFingerprint: string | null;
    mutationEnvelopeHash: string | null;
    observationIds: readonly string[];
    claimIds: readonly string[];
    eventIds: readonly string[];
    redactionState?: ProfileMemoryMutationJournalEntryV1["redactionState"];
  }
): {
  nextState: ProfileMemoryMutationJournalStateV1;
  entry: ProfileMemoryMutationJournalEntryV1 | null;
  appended: boolean;
} {
  const observationIds = dedupeSortedStrings(input.observationIds);
  const claimIds = dedupeSortedStrings(input.claimIds);
  const eventIds = dedupeSortedStrings(input.eventIds);
  if (observationIds.length === 0 && claimIds.length === 0 && eventIds.length === 0) {
    return {
      nextState: state,
      entry: null,
      appended: false
    };
  }
  const redactionState = input.redactionState ?? "not_requested";
  const sourceTaskId = normalizeOptionalMetadataString(input.sourceTaskId);
  const sourceFingerprint = normalizeOptionalMetadataString(input.sourceFingerprint);
  const mutationEnvelopeHash = normalizeOptionalMetadataString(input.mutationEnvelopeHash);
  const entryId = buildProfileMemoryMutationJournalEntryId({
    recordedAt: input.recordedAt,
    sourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash,
    observationIds,
    claimIds,
    eventIds,
    redactionState
  });
  const existing = state.entries.find((entry) =>
    buildProfileMemoryMutationJournalCanonicalEntryId(entry) === entryId
  );
  if (existing) {
    return {
      nextState: state,
      entry: existing,
      appended: false
    };
  }
  const entry: ProfileMemoryMutationJournalEntryV1 = {
    journalEntryId: entryId,
    watermark: state.nextWatermark,
    recordedAt: input.recordedAt,
    sourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash,
    observationIds,
    claimIds,
    eventIds,
    redactionState
  };
  return {
    nextState: {
      schemaVersion: "v1",
      nextWatermark: state.nextWatermark + 1,
      entries: [...state.entries, entry]
    },
    entry,
    appended: true
  };
}

/**
 * Enforces bounded mutation-journal retention against the current compaction policy while keeping
 * one replay-safe snapshot watermark for the compacted prefix.
 *
 * @param state - Existing bounded mutation-journal state.
 * @param compaction - Current graph compaction settings.
 * @param recordedAt - Timestamp for compaction-side metadata updates.
 * @returns Journal and compaction state after bounded cap enforcement.
 */
export function compactProfileMemoryMutationJournalState(input: {
  state: ProfileMemoryMutationJournalStateV1;
  compaction: ProfileMemoryGraphCompactionStateV1;
  recordedAt: string;
}): {
  nextState: ProfileMemoryMutationJournalStateV1;
  nextCompaction: ProfileMemoryGraphCompactionStateV1;
  changed: boolean;
} {
  const entries = [...input.state.entries].sort((left, right) => left.watermark - right.watermark);
  const highestPersistedWatermark = Math.max(0, input.state.nextWatermark - 1);
  const maxSnapshotWatermark = entries.length > 0
    ? Math.max(0, entries[0]!.watermark - 1)
    : highestPersistedWatermark;
  let snapshotWatermark = Math.min(input.compaction.snapshotWatermark, maxSnapshotWatermark);
  let lastCompactedAt = input.compaction.lastCompactedAt;
  let retainedEntries = entries;
  if (entries.length > input.compaction.maxJournalEntries) {
    const overflowCount = entries.length - input.compaction.maxJournalEntries;
    const removedEntries = entries.slice(0, overflowCount);
    retainedEntries = entries.slice(overflowCount);
    snapshotWatermark = Math.max(
      snapshotWatermark,
      removedEntries[removedEntries.length - 1]?.watermark ?? snapshotWatermark
    );
    lastCompactedAt = input.recordedAt;
  }

  const journalChanged =
    retainedEntries.length !== input.state.entries.length ||
    retainedEntries.some((entry, index) => entry !== input.state.entries[index]);
  const compactionChanged =
    snapshotWatermark !== input.compaction.snapshotWatermark ||
    lastCompactedAt !== input.compaction.lastCompactedAt;
  return {
    nextState: journalChanged
      ? {
        schemaVersion: "v1",
        nextWatermark: input.state.nextWatermark,
        entries: retainedEntries
      }
      : input.state,
    nextCompaction: compactionChanged
      ? {
        ...input.compaction,
        snapshotWatermark,
        lastCompactedAt
      }
      : input.compaction,
    changed: journalChanged || compactionChanged
  };
}

/**
 * Checks whether one candidate is a non-negative integer.
 *
 * @param value - Unknown candidate.
 * @returns `true` when the value is a non-negative integer.
 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Checks whether one candidate is a positive integer.
 *
 * @param value - Unknown candidate.
 * @returns `true` when the value is a positive integer.
 */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Deduplicates and sorts one string collection for deterministic journal payloads.
 *
 * @param values - Candidate string values.
 * @returns Sorted unique values.
 */
function dedupeSortedStrings(values: readonly string[]): string[] {
  return [...new Set(
    values.flatMap((value) => {
      if (typeof value !== "string") {
        return [];
      }
      const trimmed = value.trim();
      return trimmed.length > 0 ? [trimmed] : [];
    })
  )].sort((left, right) => left.localeCompare(right));
}

/**
 * Deduplicates malformed persisted journal entries by deterministic id and repairs them into one
 * strictly increasing replay order so the derived read model stays keyed by one canonical
 * watermark sequence.
 *
 * @param entries - Validated persisted journal entries.
 * @returns Canonical replay-safe journal entries.
 */
function normalizeJournalEntries(
  entries: readonly NormalizedJournalEntryCandidate[]
): ProfileMemoryMutationJournalEntryV1[] {
  const deduped = new Map<string, NormalizedJournalEntryCandidate>();
  for (const candidate of entries) {
    const existing = deduped.get(candidate.entry.journalEntryId);
    if (!existing || compareJournalEntryFreshness(existing.entry, candidate.entry) < 0) {
      deduped.set(candidate.entry.journalEntryId, candidate);
    }
  }
  const dedupedByCanonicalPayload = new Map<string, { candidate: NormalizedJournalEntryCandidate; duplicateCount: number }>();
  for (const candidate of deduped.values()) {
    const canonicalJournalEntryId = buildProfileMemoryMutationJournalCanonicalEntryId(candidate.entry);
    const existing = dedupedByCanonicalPayload.get(canonicalJournalEntryId);
    if (!existing) {
      dedupedByCanonicalPayload.set(canonicalJournalEntryId, { candidate, duplicateCount: 1 });
      continue;
    }
    dedupedByCanonicalPayload.set(canonicalJournalEntryId, {
      candidate: compareJournalEntryFreshness(existing.candidate.entry, candidate.entry) < 0
        ? candidate
        : existing.candidate,
      duplicateCount: existing.duplicateCount + 1
    });
  }
  const ordered = [...dedupedByCanonicalPayload.entries()]
    .map(([canonicalJournalEntryId, candidate]) => {
      if (
        candidate.duplicateCount > 1 &&
        candidate.candidate.entry.journalEntryId !== canonicalJournalEntryId
      ) {
        return { entry: { ...candidate.candidate.entry, journalEntryId: canonicalJournalEntryId }, watermarkRecovered: candidate.candidate.watermarkRecovered };
      }
      return candidate.candidate;
    })
    .sort(compareJournalEntryCandidateReplayOrder);
  let previousWatermark = 0;
  return ordered.map((candidate) => {
    const entry = candidate.entry;
    const nextWatermark = Math.max(previousWatermark + 1, entry.watermark);
    previousWatermark = nextWatermark;
    return nextWatermark === entry.watermark
      ? entry
      : {
        ...entry,
        watermark: nextWatermark
      };
  });
}

type NormalizedJournalEntryCandidate = { entry: ProfileMemoryMutationJournalEntryV1; watermarkRecovered: boolean };
/**
 * Compares two journal entries so duplicate ids keep one deterministic winner.
 *
 * @param left - Existing journal entry.
 * @param right - Incoming journal entry.
 * @returns Positive when `left` is fresher, negative when `right` is fresher.
 */
function compareJournalEntryFreshness(
  left: ProfileMemoryMutationJournalEntryV1,
  right: ProfileMemoryMutationJournalEntryV1
): number {
  if (left.watermark !== right.watermark) {
    return left.watermark - right.watermark;
  }
  const leftRecordedAt = normalizeRecordedAtForComparison(left.recordedAt);
  const rightRecordedAt = normalizeRecordedAtForComparison(right.recordedAt);
  if (leftRecordedAt !== rightRecordedAt) {
    return leftRecordedAt.localeCompare(rightRecordedAt);
  }
  const journalEntryIdComparison = left.journalEntryId.localeCompare(right.journalEntryId);
  if (journalEntryIdComparison !== 0) {
    return journalEntryIdComparison;
  }
  const leftCanonicalJournalEntryId = buildProfileMemoryMutationJournalCanonicalEntryId(left);
  const rightCanonicalJournalEntryId = buildProfileMemoryMutationJournalCanonicalEntryId(right);
  return leftCanonicalJournalEntryId.localeCompare(rightCanonicalJournalEntryId);
}

/**
 * Sorts journal entries into one deterministic replay order.
 *
 * @param left - Left journal entry.
 * @param right - Right journal entry.
 * @returns Negative when `left` should replay first.
 */
function compareJournalEntryReplayOrder(
  left: ProfileMemoryMutationJournalEntryV1,
  right: ProfileMemoryMutationJournalEntryV1
): number {
  if (left.watermark !== right.watermark) {
    return left.watermark - right.watermark;
  }
  const leftRecordedAt = normalizeRecordedAtForComparison(left.recordedAt);
  const rightRecordedAt = normalizeRecordedAtForComparison(right.recordedAt);
  if (leftRecordedAt !== rightRecordedAt) {
    return leftRecordedAt.localeCompare(rightRecordedAt);
  }
  const leftCanonicalJournalEntryId = buildProfileMemoryMutationJournalCanonicalEntryId(left);
  const rightCanonicalJournalEntryId = buildProfileMemoryMutationJournalCanonicalEntryId(right);
  if (leftCanonicalJournalEntryId !== rightCanonicalJournalEntryId) {
    return leftCanonicalJournalEntryId.localeCompare(rightCanonicalJournalEntryId);
  }
  return left.journalEntryId.localeCompare(right.journalEntryId);
}

/**
 * Sorts normalized journal candidates into one deterministic replay order, including entries whose
 * watermarks were recovered during load normalization.
 *
 * @param left - Left normalized journal candidate.
 * @param right - Right normalized journal candidate.
 * @returns Negative when `left` should replay first.
 */
function compareJournalEntryCandidateReplayOrder(
  left: NormalizedJournalEntryCandidate,
  right: NormalizedJournalEntryCandidate
): number {
  if (!left.watermarkRecovered && !right.watermarkRecovered) {
    return compareJournalEntryReplayOrder(left.entry, right.entry);
  }
  const leftRecordedAt = normalizeRecordedAtForComparison(left.entry.recordedAt);
  const rightRecordedAt = normalizeRecordedAtForComparison(right.entry.recordedAt);
  if (leftRecordedAt !== rightRecordedAt) {
    return leftRecordedAt.localeCompare(rightRecordedAt);
  }
  if (left.watermarkRecovered !== right.watermarkRecovered) {
    return left.watermarkRecovered ? 1 : -1;
  }
  const leftCanonicalJournalEntryId = buildProfileMemoryMutationJournalCanonicalEntryId(left.entry);
  const rightCanonicalJournalEntryId = buildProfileMemoryMutationJournalCanonicalEntryId(
    right.entry
  );
  if (leftCanonicalJournalEntryId !== rightCanonicalJournalEntryId) {
    return leftCanonicalJournalEntryId.localeCompare(rightCanonicalJournalEntryId);
  }
  return left.entry.journalEntryId.localeCompare(right.entry.journalEntryId);
}
