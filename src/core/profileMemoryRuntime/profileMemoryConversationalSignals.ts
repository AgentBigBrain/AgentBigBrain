/**
 * @fileoverview Shared bounded conversational signal helpers for profile-memory Phase 1 routing.
 */

import { extractProfileFactCandidatesFromUserInput } from "./profileMemoryExtraction";
import { extractProfileEpisodeCandidatesFromUserInput } from "./profileMemoryEpisodeExtraction";

const CONVERSATIONAL_PROFILE_UPDATE_FACT_PREFIXES = [
  "identity.",
  "contact.",
  "employment.",
  "residence."
] as const;
const SIGNAL_ASSESSMENT_SOURCE_TASK_ID = "profile_signal_assessment";
const SIGNAL_ASSESSMENT_OBSERVED_AT = "1970-01-01T00:00:00.000Z";
const QUESTION_LEAD_TOKENS = new Set([
  "who",
  "what",
  "when",
  "where",
  "why",
  "how",
  "do",
  "does",
  "did",
  "is",
  "are",
  "was",
  "were",
  "can",
  "could",
  "would",
  "should"
]);
const WORKFLOW_OR_STATUS_CUE_TOKENS = new Set([
  "build",
  "deploy",
  "run",
  "open",
  "close",
  "resume",
  "continue",
  "status",
  "review",
  "preview",
  "browser",
  "workspace",
  "repo",
  "project"
]);
const RELATIONSHIP_UPDATE_MARKER_SEQUENCES: readonly (readonly string[])[] = [
  ["used", "to"],
  ["no", "longer"],
  ["worked", "with"],
  ["work", "with"],
  ["works", "with"],
  ["now", "works"],
  ["works", "somewhere", "else"],
  ["someone", "i", "worked"]
] as const;
const RELATIONSHIP_UPDATE_MARKER_TOKENS = new Set([
  "previously",
  "formerly",
  "anymore"
]);

/**
 * Tokenizes conversational signal input.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param userInput - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function tokenizeConversationalSignalInput(userInput: string): {
  normalized: string;
  tokens: readonly string[];
} {
  const normalized = userInput.replace(/\s+/g, " ").trim();
  const lowered = normalized.toLowerCase();
  const tokens = lowered
    .replace(/[^a-z0-9' -]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0);
  return {
    normalized,
    tokens
  };
}

/**
 * Evaluates whether token sequence.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param tokens - Input consumed by this helper.
 * @param sequence - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function hasTokenSequence(
  tokens: readonly string[],
  sequence: readonly string[]
): boolean {
  if (sequence.length === 0 || sequence.length > tokens.length) {
    return false;
  }
  for (let index = 0; index <= tokens.length - sequence.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (tokens[index + offset] !== sequence[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return true;
    }
  }
  return false;
}

/**
 * Evaluates whether any token sequence.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param tokens - Input consumed by this helper.
 * @param sequences - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function hasAnyTokenSequence(
  tokens: readonly string[],
  sequences: readonly (readonly string[])[]
): boolean {
  return sequences.some((sequence) => hasTokenSequence(tokens, sequence));
}

/**
 * Evaluates whether any token.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param tokens - Input consumed by this helper.
 * @param cues - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function hasAnyToken(tokens: readonly string[], cues: ReadonlySet<string>): boolean {
  return tokens.some((token) => cues.has(token));
}

/**
 * Evaluates whether upper ascii letter.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function isUpperAsciiLetter(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  const code = value.charCodeAt(0);
  return code >= 65 && code <= 90;
}

/**
 * Evaluates whether alpha numeric or name punctuation.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param char - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function isAlphaNumericOrNamePunctuation(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    char === "'" ||
    char === "." ||
    char === "-"
  );
}

/**
 * Trims name boundary punctuation.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param token - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function trimNameBoundaryPunctuation(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && !isAlphaNumericOrNamePunctuation(token[start]!)) {
    start += 1;
  }
  while (end > start && !isAlphaNumericOrNamePunctuation(token[end - 1]!)) {
    end -= 1;
  }
  return token.slice(start, end);
}

/**
 * Evaluates whether capitalized name like span.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function containsCapitalizedNameLikeSpan(value: string): boolean {
  const rawTokens = value.split(/\s+/).filter((token) => token.length > 0);
  let spanLength = 0;
  for (const rawToken of rawTokens) {
    const cleaned = trimNameBoundaryPunctuation(rawToken);
    if (cleaned && isUpperAsciiLetter(cleaned)) {
      spanLength += 1;
      if (spanLength <= 3) {
        return true;
      }
      continue;
    }
    spanLength = 0;
  }
  return false;
}

/**
 * Returns whether bounded third-person relationship update wording should count as conversational
 * profile memory even when the deterministic extractors do not yet emit a concrete fact or episode
 * candidate from the same sentence shape.
 *
 * @param userInput - Raw user utterance under analysis.
 * @returns `true` when the wording looks like a factual relationship update rather than recall.
 */
function hasRelationshipNarrativeUpdateSignal(userInput: string): boolean {
  const { normalized, tokens } = tokenizeConversationalSignalInput(userInput);
  if (!normalized) {
    return false;
  }
  if (normalized.includes("?") || normalized.includes("¿")) {
    return false;
  }
  if (tokens.length > 0 && QUESTION_LEAD_TOKENS.has(tokens[0]!)) {
    return false;
  }
  if (hasAnyToken(tokens, WORKFLOW_OR_STATUS_CUE_TOKENS)) {
    return false;
  }
  const hasRelationshipUpdateMarker =
    hasAnyToken(tokens, RELATIONSHIP_UPDATE_MARKER_TOKENS) ||
    hasAnyTokenSequence(tokens, RELATIONSHIP_UPDATE_MARKER_SEQUENCES);
  if (!hasRelationshipUpdateMarker) {
    return false;
  }
  return containsCapitalizedNameLikeSpan(normalized);
}

/**
 * Returns whether raw user wording contains one bounded conversational profile update signal that
 * should share the canonical direct-chat and broker ingest posture.
 *
 * @param userInput - Raw user utterance under analysis.
 * @returns `true` when bounded identity/contact/employment/residence facts are extractable.
 */
export function hasConversationalProfileUpdateSignal(userInput: string): boolean {
  const factSignal = extractProfileFactCandidatesFromUserInput(
    userInput,
    SIGNAL_ASSESSMENT_SOURCE_TASK_ID,
    SIGNAL_ASSESSMENT_OBSERVED_AT
  ).some((candidate) =>
    CONVERSATIONAL_PROFILE_UPDATE_FACT_PREFIXES.some((prefix) => candidate.key.startsWith(prefix))
  );
  if (factSignal) {
    return true;
  }
  const episodeSignal = extractProfileEpisodeCandidatesFromUserInput(
    userInput,
    SIGNAL_ASSESSMENT_SOURCE_TASK_ID,
    SIGNAL_ASSESSMENT_OBSERVED_AT
  ).length > 0;
  if (episodeSignal) {
    return true;
  }
  return hasRelationshipNarrativeUpdateSignal(userInput);
}
