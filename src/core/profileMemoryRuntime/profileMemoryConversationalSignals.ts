/**
 * @fileoverview Shared bounded conversational signal helpers for profile-memory Phase 1 routing.
 */

import { extractPreferredNameValuesFromUserInput } from "./profileMemoryExtraction";
import {
  extractResolvedFollowupFacts,
  extractSegmentValueAfterContainedPrefix,
  extractWrappedProfileMemoryClauses,
  splitExplicitProfileSegments
} from "./profileMemoryExtractionSupport";

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
    hasAnyTokenSequence(tokens, RELATIONSHIP_UPDATE_MARKER_SEQUENCES) ||
    /\b[A-Z][A-Za-z'.-]{0,30}(?:\s+[A-Z][A-Za-z'.-]{0,30}){0,2}\s+is\s+my\s+[A-Za-z][A-Za-z_-]{1,30}\b/.test(normalized);
  if (!hasRelationshipUpdateMarker) {
    return false;
  }
  return containsCapitalizedNameLikeSpan(normalized);
}

/**
 * Returns whether segmented relationship update wording should count as conversational profile
 * memory. Workflow words in a different segment must not suppress a later explicit relationship
 * clause from the same user turn.
 *
 * @param userInput - Raw user utterance under analysis.
 * @returns `true` when one bounded segment carries relationship-update wording.
 */
function hasSegmentedRelationshipNarrativeUpdateSignal(userInput: string): boolean {
  const candidateClauses = [
    userInput,
    ...splitExplicitProfileSegments(userInput),
    ...extractWrappedProfileMemoryClauses(userInput).flatMap((clause) =>
      splitExplicitProfileSegments(clause)
    )
  ];
  for (const clause of candidateClauses) {
    const { normalized, tokens } = tokenizeConversationalSignalInput(clause);
    if (!normalized) {
      continue;
    }
    if (normalized.includes("?") || normalized.includes("\u00bf")) {
      continue;
    }
    if (tokens.length > 0 && QUESTION_LEAD_TOKENS.has(tokens[0]!)) {
      continue;
    }
    if (hasAnyToken(tokens, WORKFLOW_OR_STATUS_CUE_TOKENS)) {
      continue;
    }
    const hasRelationshipUpdateMarker =
      hasAnyToken(tokens, RELATIONSHIP_UPDATE_MARKER_TOKENS) ||
      hasAnyTokenSequence(tokens, RELATIONSHIP_UPDATE_MARKER_SEQUENCES) ||
      /\b[A-Z][A-Za-z'.-]{0,30}(?:\s+[A-Z][A-Za-z'.-]{0,30}){0,2}\s+is\s+my\s+[A-Za-z][A-Za-z_-]{1,30}\b/.test(normalized) ||
      /\bmy\s+(?:friend|partner|spouse|wife|husband|girlfriend|boyfriend|acquaintance|boss|coworker|colleague|work\s+peer|peer|manager|supervisor|lead|team\s+lead|employee|direct\s+report|neighbor|neighbour|roommate|relative|distant\s+relative|family\s+member|cousin|aunt|uncle|mom|mother|dad|father|son|daughter|parent|child|sibling|sister|brother|teammate|classmate)\s+is\s+[A-Z][A-Za-z'.-]{0,30}\b/i.test(normalized) ||
      /\bi(?:\s+also)?\s+(?:know|met)\s+(?:another|a\s+different)\s+[A-Z][A-Za-z'.-]{0,30}\s+(?:at|from)\s+[A-Z][A-Za-z0-9'&.-]*/i.test(normalized) ||
      /\bthe\s+[A-Z][A-Za-z'.-]{0,30}\s+from\s+[A-Z][A-Za-z0-9'&.-]*(?:\s+[A-Z][A-Za-z0-9'&.-]*)*\s+sometimes\s+goes\s+by\s+[A-Z][A-Za-z'.-]{0,20}\b/.test(normalized) ||
      /\b[A-Z][A-Za-z'.-]{0,30}(?:\s+[A-Z][A-Za-z'.-]{0,30}){0,2}\s+(?:sold|bought)\s+[A-Z][A-Za-z'.-]{0,30}(?:\s+[A-Z][A-Za-z'.-]{0,30}){0,2}\b/.test(normalized);
    if (hasRelationshipUpdateMarker && containsCapitalizedNameLikeSpan(normalized)) {
      return true;
    }
  }
  return false;
}

/**
 * Returns profile-memory clauses that can be checked without running full extraction.
 *
 * **Why it exists:**
 * Conversational write gating should inspect only narrow profile declaration shapes, not broad
 * fact and episode extractors that would expand memory authority before policy runs.
 *
 * **What it talks to:**
 * - Uses `extractWrappedProfileMemoryClauses` (import) from `./profileMemoryExtractionSupport`.
 *
 * @param userInput - Raw user utterance under analysis.
 * @returns Direct and wrapped profile-memory clauses.
 */
function buildConversationalSignalClauses(userInput: string): readonly string[] {
  const text = userInput.trim();
  if (!text) {
    return [];
  }
  return [text, ...extractWrappedProfileMemoryClauses(text)];
}

/**
 * Returns whether one turn contains a narrow first-person profile declaration.
 *
 * **Why it exists:**
 * Direct identity, employment, and residence declarations should still write memory even after
 * broad extraction stops owning the conversation write gate.
 *
 * **What it talks to:**
 * - Uses `extractPreferredNameValuesFromUserInput` (import) from `./profileMemoryExtraction`.
 * - Uses profile extraction support helpers from `./profileMemoryExtractionSupport`.
 *
 * @param userInput - Raw user utterance under analysis.
 * @returns `true` when exact self-profile declaration wording is present.
 */
function hasExactSelfProfileDeclarationSignal(userInput: string): boolean {
  for (const clause of buildConversationalSignalClauses(userInput)) {
    if (extractPreferredNameValuesFromUserInput(clause).length > 0) {
      return true;
    }
    for (const segment of splitExplicitProfileSegments(clause)) {
      if (
        extractSegmentValueAfterContainedPrefix(segment, ["i work at ", "i work for "]) ||
        extractSegmentValueAfterContainedPrefix(segment, ["my job is ", "my new job is "]) ||
        extractSegmentValueAfterContainedPrefix(segment, ["i live in ", "i moved to "])
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Returns whether one turn contains explicit follow-up resolution wording.
 *
 * **Why it exists:**
 * Follow-up resolution is a bounded commitment lane and should not depend on unrelated broad
 * profile extractors to open the write path.
 *
 * **What it talks to:**
 * - Uses `extractResolvedFollowupFacts` (import) from `./profileMemoryExtractionSupport`.
 *
 * @param userInput - Raw user utterance under analysis.
 * @returns `true` when explicit follow-up resolution facts can be extracted.
 */
function hasExplicitFollowupResolutionSignal(userInput: string): boolean {
  return buildConversationalSignalClauses(userInput).some(
    (clause) =>
      extractResolvedFollowupFacts(
        clause,
        SIGNAL_ASSESSMENT_SOURCE_TASK_ID,
        SIGNAL_ASSESSMENT_OBSERVED_AT
      ).length > 0
  );
}

/**
 * Returns whether raw user wording contains one bounded conversational profile update signal that
 * should share the canonical direct-chat and broker ingest posture.
 *
 * @param userInput - Raw user utterance under analysis.
 * @returns `true` when bounded identity/contact/employment/residence facts are extractable.
 */
export function hasConversationalProfileUpdateSignal(userInput: string): boolean {
  if (hasExactSelfProfileDeclarationSignal(userInput)) {
    return true;
  }
  if (hasExplicitFollowupResolutionSignal(userInput)) {
    return true;
  }
  return (
    hasSegmentedRelationshipNarrativeUpdateSignal(userInput) ||
    hasRelationshipNarrativeUpdateSignal(userInput)
  );
}
