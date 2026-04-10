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

const EPISODE_TRANSFER_PATTERN = new RegExp(
  `\\b${EPISODE_SUBJECT_PATTERN}\\s+sold\\s+${EPISODE_SUBJECT_PATTERN}\\s+the\\s+([A-Za-z0-9' -]+)\\b`,
  "i"
);

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
    const transferCandidate = extractTransferEpisodeCandidate(
      sentence,
      sourceTaskId,
      observedAt,
      seen
    );
    if (transferCandidate) {
      candidates.push(transferCandidate);
      continue;
    }
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
 * Extracts one bounded person-to-person transfer event episode from a natural-language sentence.
 *
 * **Why it exists:**
 * Phase 8 needs real conversational ingest for event-shaped relational memory such as
 * `Milo sold Jordan the gray Accord in late 2024.` before transcript-shaped participant-role recall
 * can be proven through the live manager/runtime path.
 *
 * **What it talks to:**
 * - Uses `trimTrailingClausePunctuation`, `displayNameFromContactToken`, and
 *   `normalizeProfileValue` from `./profileMemoryNormalization`.
 * - Uses local episode extraction helpers within this module.
 *
 * @param sentence - One normalized sentence-like segment from the current user turn.
 * @param sourceTaskId - Task id used for traceability on extracted episodes.
 * @param observedAt - Observation timestamp applied to extracted episodes.
 * @param seen - Current per-utterance dedupe set.
 * @returns Canonical transfer episode candidate, or `null` when the sentence does not match.
 */
function extractTransferEpisodeCandidate(
  sentence: string,
  sourceTaskId: string,
  observedAt: string,
  seen: Set<string>
): CreateProfileEpisodeRecordInput | null {
  const match = EPISODE_TRANSFER_PATTERN.exec(sentence);
  if (!match) {
    return null;
  }

  const sellerRawName = trimTrailingClausePunctuation(match[1] ?? "");
  const buyerRawName = trimTrailingClausePunctuation(match[2] ?? "");
  const rawObject = trimTrailingClausePunctuation(match[3] ?? "");
  const sellerToken = extractEpisodeContactToken(sellerRawName);
  const buyerToken = extractEpisodeContactToken(buyerRawName);
  const objectSurface = trimTransferEpisodeObjectSurface(rawObject);
  if (!sellerToken || !buyerToken || !objectSurface || sellerToken === buyerToken) {
    return null;
  }

  const sellerDisplayName = displayNameFromContactToken(sellerToken);
  const buyerDisplayName = displayNameFromContactToken(buyerToken);
  const title = `${sellerDisplayName} sold ${buyerDisplayName} the ${objectSurface}`;
  const summary = trimTrailingClausePunctuation(sentence);
  const signature = `sale|${sellerToken}|${buyerToken}|${objectSurface.toLowerCase()}`;
  if (seen.has(signature)) {
    return null;
  }
  seen.add(signature);
  return {
    title,
    summary,
    sourceTaskId,
    source: "user_input_pattern.episode_candidate",
    sourceKind: "explicit_user_statement",
    sensitive: false,
    observedAt,
    confidence: toEpisodeConfidence(sentence),
    entityRefs: [`contact.${sellerToken}`, `contact.${buyerToken}`, objectSurface],
    tags: ["followup", "transaction", "transfer"]
  };
}

/**
 * Trims trailing time-only phrasing from one transfer-event object surface.
 *
 * @param rawObject - Raw object surface captured from the transfer-event regex.
 * @returns Canonical object surface, or an empty string when nothing bounded remains.
 */
function trimTransferEpisodeObjectSurface(rawObject: string): string {
  const withoutTrailingTime = rawObject.replace(
    /\s+in\s+(?:late|early|mid)?\s*[A-Za-z0-9' -]+$/i,
    ""
  );
  return normalizeProfileValue(withoutTrailingTime);
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
