/**
 * @fileoverview Deterministic episodic-memory extraction from raw user input.
 */

import type { CreateProfileEpisodeRecordInput } from "./profileMemoryEpisodeContracts";
import {
  displayNameFromContactToken,
  normalizeProfileKey,
  normalizeProfileValue,
  trimTrailingClausePunctuation
} from "./profileMemoryNormalization";

interface EpisodePattern {
  pattern: RegExp;
  canonicalEvent: string;
  tags: readonly string[];
}

const EPISODE_SUBJECT_PATTERN =
  "([A-Z][A-Za-z']+(?:[ -][A-Z][A-Za-z']+){0,2})";
const EPISODE_NAME_CANDIDATE_PATTERN = /[A-Z][A-Za-z']+(?:[ -][A-Z][A-Za-z']+){0,2}/g;
const EPISODE_NAME_STOP_WORDS = new Set([
  "A",
  "An",
  "He",
  "Her",
  "His",
  "I",
  "It",
  "My",
  "Our",
  "She",
  "Someone",
  "That",
  "The",
  "Their",
  "They",
  "This",
  "We"
]);

const EPISODE_PATTERNS: readonly EpisodePattern[] = [
  {
    pattern: new RegExp(
      `\\b${EPISODE_SUBJECT_PATTERN}\\s+(fell down|had a fall|fell and got hurt)\\b`,
      "i"
    ),
    canonicalEvent: "fell down",
    tags: ["injury", "fall", "followup"]
  },
  {
    pattern: new RegExp(
      `\\b${EPISODE_SUBJECT_PATTERN}\\s+(got hurt|was hurt|got injured|was injured)\\b`,
      "i"
    ),
    canonicalEvent: "got hurt",
    tags: ["injury", "followup"]
  },
  {
    pattern: new RegExp(
      `\\b${EPISODE_SUBJECT_PATTERN}\\s+(got sick|was sick|has been sick)\\b`,
      "i"
    ),
    canonicalEvent: "got sick",
    tags: ["health", "followup"]
  },
  {
    pattern: new RegExp(
      `\\b${EPISODE_SUBJECT_PATTERN}\\s+(was hospitalized|went to the hospital|had surgery)\\b`,
      "i"
    ),
    canonicalEvent: "had a medical situation",
    tags: ["health", "medical", "followup"]
  },
  {
    pattern: new RegExp(
      `\\b${EPISODE_SUBJECT_PATTERN}\\s+(lost (?:his|her|their) job|got fired)\\b`,
      "i"
    ),
    canonicalEvent: "lost a job",
    tags: ["work", "followup"]
  },
  {
    pattern: new RegExp(
      `\\b${EPISODE_SUBJECT_PATTERN}\\s+(was in an accident|got into an accident)\\b`,
      "i"
    ),
    canonicalEvent: "was in an accident",
    tags: ["accident", "followup"]
  }
];

/**
 * Extracts bounded episodic-memory candidates from raw user text.
 *
 * @param userInput - Raw user utterance or wrapped execution input text.
 * @param sourceTaskId - Task id used for traceability on extracted episodes.
 * @param observedAt - Observation timestamp applied to extracted episodes.
 * @returns Deduplicated episodic-memory candidates ready for mutation.
 */
export function extractProfileEpisodeCandidatesFromUserInput(
  userInput: string,
  sourceTaskId: string,
  observedAt: string
): CreateProfileEpisodeRecordInput[] {
  const text = normalizeProfileValue(userInput);
  if (!text) {
    return [];
  }

  const candidates: CreateProfileEpisodeRecordInput[] = [];
  const seen = new Set<string>();
  const sentences = splitIntoEpisodeSentences(userInput);

  for (const sentence of sentences) {
    for (const episodePattern of EPISODE_PATTERNS) {
      const match = episodePattern.pattern.exec(sentence);
      if (!match) {
        continue;
      }

      const rawName = trimTrailingClausePunctuation(match[1] ?? "");
      const contactToken = extractEpisodeContactToken(rawName);
      if (!contactToken) {
        continue;
      }

      const displayName = displayNameFromContactToken(contactToken);
      const title = `${displayName} ${episodePattern.canonicalEvent}`;
      const summary = trimTrailingClausePunctuation(sentence);
      const signature = `${contactToken}|${episodePattern.canonicalEvent}`;
      if (seen.has(signature)) {
        continue;
      }
      seen.add(signature);
      candidates.push({
        title,
        summary,
        sourceTaskId,
        source: "user_input_pattern.episode_candidate",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        observedAt,
        confidence: toEpisodeConfidence(sentence),
        entityRefs: [`contact.${contactToken}`],
        tags: episodePattern.tags
      });
      break;
    }
  }

  return candidates;
}

/**
 * Splits text into sentence-like segments suitable for bounded episode extraction.
 *
 * @param text - Raw user text under analysis.
 * @returns Normalized sentence-like segments.
 */
function splitIntoEpisodeSentences(text: string): string[] {
  return text
    .split(/[\n.!?]+/)
    .map((segment) => normalizeProfileValue(segment))
    .filter((segment) => segment.length >= 8);
}

/**
 * Builds deterministic confidence scores for extracted episode sentences.
 *
 * @param text - Source sentence or phrase.
 * @returns Confidence score in the `[0, 1]` range.
 */
function toEpisodeConfidence(text: string): number {
  const normalized = text.toLowerCase();
  return normalized.includes("maybe") ||
    normalized.includes("might") ||
    normalized.includes("not sure") ||
    normalized.includes("i think")
    ? 0.72
    : 0.9;
}

/**
 * Resolves one bounded contact token from a regex-matched episode subject span.
 *
 * @param rawName - Raw subject span matched before the event phrase.
 * @returns Normalized contact token, or null when no credible name-like subject exists.
 */
function extractEpisodeContactToken(rawName: string): string | null {
  const candidates = [...rawName.matchAll(EPISODE_NAME_CANDIDATE_PATTERN)]
    .map((match) => trimTrailingClausePunctuation(match[0] ?? ""))
    .filter((candidate) => candidate.length > 0)
    .filter((candidate) => !EPISODE_NAME_STOP_WORDS.has(candidate));
  if (candidates.length === 0) {
    return null;
  }
  return normalizeProfileKey(candidates[candidates.length - 1] ?? "");
}
