/**
 * @fileoverview Bounded episodic-memory resolution helpers for follow-up outcomes.
 */

import type { ProfileMemoryState } from "../profileMemory";
import type {
  ProfileEpisodeRecord,
  ProfileEpisodeResolutionInput,
  ProfileEpisodeResolutionStatus
} from "./profileMemoryEpisodeContracts";
import { buildProfileEpisodeConsolidationKey } from "./profileMemoryEpisodeConsolidation";
import { isTerminalProfileEpisodeStatus } from "./profileMemoryEpisodeState";
import { normalizeProfileKey, normalizeProfileValue } from "./profileMemoryNormalization";

interface ResolutionSignal {
  status: ProfileEpisodeResolutionStatus;
  matchedText: string;
}

const RESOLUTION_SIGNAL_PATTERNS: readonly {
  pattern: RegExp;
  status: ProfileEpisodeResolutionStatus;
}[] = [
  {
    pattern: /\b(?:is doing better|doing better now|is better now|is okay now|is fine now|recovered|got better|worked out|got sorted out|is resolved)\b/i,
    status: "resolved"
  },
  {
    pattern: /\b(?:is improving|is mostly okay now|is partly sorted out|partially resolved)\b/i,
    status: "partially_resolved"
  },
  {
    pattern: /\b(?:not sure how it ended|outcome is unclear|still unclear|don't know how it ended)\b/i,
    status: "outcome_unknown"
  },
  {
    pattern: /\b(?:no longer relevant|doesn't matter anymore|not relevant anymore)\b/i,
    status: "no_longer_relevant"
  }
];

/**
 * Builds deterministic episode-resolution candidates from later user updates.
 *
 * @param state - Loaded profile-memory state.
 * @param userInput - Raw user text under ingestion.
 * @param sourceTaskId - Task identifier for generated resolution metadata.
 * @param observedAt - Observation timestamp for generated resolutions.
 * @returns Resolution candidates inferred from the update text.
 */
export function buildInferredProfileEpisodeResolutionCandidates(
  state: ProfileMemoryState,
  userInput: string,
  sourceTaskId: string,
  observedAt: string
): ProfileEpisodeResolutionInput[] {
  const text = normalizeProfileValue(userInput);
  if (!text) {
    return [];
  }

  const signal = detectResolutionSignal(text);
  if (!signal) {
    return [];
  }

  const mentionedEntityRefs = extractMentionedEntityRefs(text);
  if (mentionedEntityRefs.length === 0) {
    return [];
  }

  const candidates: ProfileEpisodeResolutionInput[] = [];
  const seenEpisodeIds = new Set<string>();

  for (const entityRef of mentionedEntityRefs) {
    const matchingEpisodes = state.episodes.filter(
      (episode) =>
        !isTerminalProfileEpisodeStatus(episode.status) &&
        episode.entityRefs.includes(entityRef)
    );
    const resolvedEpisodes = selectEpisodesForResolution(matchingEpisodes, text);
    for (const episode of resolvedEpisodes) {
      if (seenEpisodeIds.has(episode.id)) {
        continue;
      }
      seenEpisodeIds.add(episode.id);
      candidates.push({
        episodeId: episode.id,
        status: signal.status,
        sourceTaskId,
        source: "user_input_pattern.episode_resolution_inferred",
        observedAt,
        confidence: 0.88,
        summary: buildResolutionSummary(episode, text, signal.matchedText),
        entityRefs: episode.entityRefs,
        openLoopRefs: episode.openLoopRefs,
        tags: episode.tags
      });
    }
  }

  return candidates;
}

/**
 * Detects whether text contains a bounded episode-resolution signal.
 *
 * @param text - Normalized user text under analysis.
 * @returns Matching signal details, or `null`.
 */
function detectResolutionSignal(text: string): ResolutionSignal | null {
  for (const signalPattern of RESOLUTION_SIGNAL_PATTERNS) {
    const match = signalPattern.pattern.exec(text);
    if (!match) {
      continue;
    }
    return {
      status: signalPattern.status,
      matchedText: match[0]
    };
  }

  return null;
}

/**
 * Extracts normalized entity refs from capitalized-name mentions in one update.
 *
 * @param text - Normalized user text under analysis.
 * @returns Mentioned entity refs in canonical profile-memory form.
 */
function extractMentionedEntityRefs(text: string): string[] {
  const refs = new Set<string>();
  const matches = text.match(/\b[A-Z][A-Za-z']*(?:\s+[A-Z][A-Za-z']*){0,3}\b/g) ?? [];
  for (const match of matches) {
    const token = normalizeProfileKey(match);
    if (!token) {
      continue;
    }
    refs.add(`contact.${token}`);
  }
  return [...refs].sort((left, right) => left.localeCompare(right));
}

/**
 * Selects which episodes are safe to resolve from one update.
 *
 * @param episodes - Candidate episodes sharing the same entity.
 * @param text - Normalized update text.
 * @returns Episodes safe to resolve from this update.
 */
function selectEpisodesForResolution(
  episodes: readonly ProfileEpisodeRecord[],
  text: string
): readonly ProfileEpisodeRecord[] {
  if (episodes.length <= 1) {
    return episodes;
  }

  const overlapped = episodes.filter((episode) => episodeHasKeywordOverlap(episode, text));
  if (overlapped.length <= 1) {
    return overlapped;
  }

  const consolidationKeys = new Set(
    overlapped.map((episode) => buildProfileEpisodeConsolidationKey(episode))
  );
  if (consolidationKeys.size !== 1) {
    return [];
  }

  return [
    [...overlapped].sort((left, right) => {
      if (left.lastMentionedAt !== right.lastMentionedAt) {
        return right.lastMentionedAt.localeCompare(left.lastMentionedAt);
      }
      return left.id.localeCompare(right.id);
    })[0]!
  ];
}

/**
 * Determines whether an update text overlaps with the core keywords of one episode.
 *
 * @param episode - Episode candidate under inspection.
 * @param text - Normalized update text.
 * @returns `true` when the text likely references the episode's core event.
 */
function episodeHasKeywordOverlap(
  episode: ProfileEpisodeRecord,
  text: string
): boolean {
  const normalizedText = text.toLowerCase();
  const tokens = normalizeProfileValue(episode.title)
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length >= 4 && token !== "with" && token !== "from");
  return tokens.some((token) => normalizedText.includes(token));
}

/**
 * Builds a bounded summary for one inferred resolution update.
 *
 * @param episode - Resolved episode.
 * @param text - Normalized user text.
 * @param matchedText - Specific resolution phrase matched by the classifier.
 * @returns Canonical resolution summary.
 */
function buildResolutionSummary(
  episode: ProfileEpisodeRecord,
  text: string,
  matchedText: string
): string {
  const compactText = text.length > 180 ? `${text.slice(0, 177)}...` : text;
  return `${episode.title}: ${compactText} (${matchedText})`;
}
