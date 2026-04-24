/**
 * @fileoverview Shared scenario-candidate primitives for episodic-memory extraction.
 */

import type { CreateProfileEpisodeRecordInput } from "./profileMemoryEpisodeContracts";
import {
  displayNameFromContactToken,
  normalizeProfileKey,
  normalizeProfileValue,
  trimTrailingClausePunctuation
} from "./profileMemoryNormalization";

export interface ScenarioEpisodeCandidateInput {
  readonly title: string;
  readonly summary: string;
  readonly sourceTaskId: string;
  readonly observedAt: string;
  readonly confidence: number;
  readonly entityRefs: readonly string[];
  readonly status: CreateProfileEpisodeRecordInput["status"];
  readonly tags: readonly string[];
}

export interface ScenarioEpisodeContext {
  lastLaunchReviewTitle: string | null;
  lastLaunchReviewEntityRefs: readonly string[];
  lastMoveContactToken: string | null;
}

const EPISODE_NAME_CANDIDATE_PATTERN = /[A-Z][A-Za-z']+(?:[ -][A-Z][A-Za-z']+){0,2}/g;
const EPISODE_NAME_STOP_WORDS = new Set([
  "A",
  "An",
  "April",
  "August",
  "December",
  "February",
  "He",
  "Her",
  "His",
  "I",
  "January",
  "It",
  "July",
  "June",
  "March",
  "My",
  "May",
  "Monday",
  "November",
  "October",
  "Our",
  "She",
  "Someone",
  "Sunday",
  "That",
  "The",
  "Their",
  "Thursday",
  "They",
  "This",
  "Tuesday",
  "Wednesday",
  "We"
]);

const EPISODE_LAUNCH_REVIEW_FOR_PATTERN =
  /\blaunch review for (?:the )?([A-Z][A-Za-z0-9'&/-]+(?:[ -][A-Z][A-Za-z0-9'&/-]+){0,4})\b/i;
const EPISODE_NAMED_LAUNCH_REVIEW_PATTERN =
  /\b([A-Z][A-Za-z0-9'&/-]+(?:[ -][A-Z][A-Za-z0-9'&/-]+){0,4}\s+launch review)\b/i;
const EPISODE_CONSIDERING_PATTERN =
  /\b([A-Z][A-Za-z0-9'&/-]+(?:[ -][A-Z][A-Za-z0-9'&/-]+){0,4})\s+(?:is|was)\s+(?:still\s+)?considering\s+(?:a|an|the)\s+([a-z0-9'/-]+(?:[ -][a-z0-9'/-]+){0,5})\b/i;
const EPISODE_MAY_REVISIT_PATTERN =
  /\b([A-Z][A-Za-z']+(?:[ -][A-Z][A-Za-z']+){0,2})\s+(?:may|might)\s+revisit\s+([a-z0-9' -]+)\b/i;
const EPISODE_MAY_MOVE_PATTERN =
  /\b([A-Z][A-Za-z']+(?:[ -][A-Z][A-Za-z']+){0,2})\s+(?:may|might)\s+(?:move|relocate)\b/i;

/**
 * Extracts pending launch review candidate.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `trimTrailingClausePunctuation` (import `trimTrailingClausePunctuation`) from `./profileMemoryNormalization`.
 * @param sentence - Input consumed by this helper.
 * @param sourceTaskId - Input consumed by this helper.
 * @param observedAt - Input consumed by this helper.
 * @param context - Input consumed by this helper.
 * @param toEpisodeConfidence - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function extractPendingLaunchReviewCandidate(
  sentence: string,
  sourceTaskId: string,
  observedAt: string,
  context: ScenarioEpisodeContext,
  toEpisodeConfidence: (text: string) => number
): ScenarioEpisodeCandidateInput | null {
  const normalizedSentence = sentence.toLowerCase();
  const mentionsReview = normalizedSentence.includes("launch review") ||
    normalizedSentence.includes("review is still pending") ||
    normalizedSentence.includes("review pending") ||
    normalizedSentence.includes("current pending milestone") ||
    normalizedSentence.includes("pending milestone");
  const mentionsPendingState = normalizedSentence.includes("pending") ||
    normalizedSentence.includes("planning");
  if (!mentionsReview || !mentionsPendingState) {
    return null;
  }

  const explicitTargetMatch = EPISODE_LAUNCH_REVIEW_FOR_PATTERN.exec(sentence);
  const namedReviewMatch = EPISODE_NAMED_LAUNCH_REVIEW_PATTERN.exec(sentence);
  const targetSurface = normalizeEpisodeSurface(
    trimTrailingClausePunctuation(explicitTargetMatch?.[1] ?? "")
  ).replace(/\s+website$/iu, "");
  const namedReviewSurface = normalizeEpisodeSurface(
    trimTrailingClausePunctuation(namedReviewMatch?.[1] ?? "")
  );
  const reviewEntitySurface = targetSurface ||
    normalizeEpisodeSurface(
      stripLeadingDateSurface(namedReviewSurface)
        .replace(/\s+launch review$/iu, "")
        .replace(/\s+website$/iu, "")
    );
  const reviewTitle = targetSurface
    ? `${targetSurface} launch review`
    : stripLeadingDateSurface(namedReviewSurface) || context.lastLaunchReviewTitle;
  if (!reviewTitle) {
    return null;
  }

  const entityRefs = reviewEntitySurface
    ? [reviewEntitySurface]
    : normalizeScenarioEntityRefs(context.lastLaunchReviewEntityRefs);
  if (entityRefs.length === 0) {
    return null;
  }

  const summary = reviewTitle === context.lastLaunchReviewTitle &&
      !namedReviewSurface &&
      !targetSurface
    ? `${reviewTitle} update after schedule change: ${trimTrailingClausePunctuation(sentence)}`
    : trimTrailingClausePunctuation(sentence);

  return {
    title: reviewTitle,
    summary,
    sourceTaskId,
    observedAt,
    confidence: toEpisodeConfidence(sentence),
    entityRefs,
    status: "unresolved",
    tags: ["followup", "milestone", "pending", "review"]
  };
}

/**
 * Extracts tentative consideration candidate.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `trimTrailingClausePunctuation` (import `trimTrailingClausePunctuation`) from `./profileMemoryNormalization`.
 * @param sentence - Input consumed by this helper.
 * @param sourceTaskId - Input consumed by this helper.
 * @param observedAt - Input consumed by this helper.
 * @param toEpisodeConfidence - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function extractTentativeConsiderationCandidate(
  sentence: string,
  sourceTaskId: string,
  observedAt: string,
  toEpisodeConfidence: (text: string) => number
): ScenarioEpisodeCandidateInput | null {
  const normalizedSentence = sentence.toLowerCase();
  if (!normalizedSentence.includes("considering") || !normalizedSentence.includes("tentative")) {
    return null;
  }

  const match = EPISODE_CONSIDERING_PATTERN.exec(sentence);
  if (!match) {
    return null;
  }

  const subjectSurface = normalizeEpisodeSurface(trimTrailingClausePunctuation(match[1] ?? ""));
  const itemSurface = normalizeEpisodeSurface(
    trimTrailingClausePunctuation(match[2] ?? "").replace(/\s+for now$/i, "")
  );
  if (!subjectSurface || !itemSurface) {
    return null;
  }

  return {
    title: `${subjectSurface} ${itemSurface}`,
    summary: trimTrailingClausePunctuation(sentence),
    sourceTaskId,
    observedAt,
    confidence: toEpisodeConfidence(sentence),
    entityRefs: [subjectSurface],
    status: "outcome_unknown",
    tags: ["planning", "tentative", "work"]
  };
}

/**
 * Extracts tentative move candidate.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `displayNameFromContactToken` (import `displayNameFromContactToken`) from `./profileMemoryNormalization`.
 * - Uses `trimTrailingClausePunctuation` (import `trimTrailingClausePunctuation`) from `./profileMemoryNormalization`.
 * @param sentence - Input consumed by this helper.
 * @param sourceTaskId - Input consumed by this helper.
 * @param observedAt - Input consumed by this helper.
 * @param context - Input consumed by this helper.
 * @param toEpisodeConfidence - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function extractTentativeMoveCandidate(
  sentence: string,
  sourceTaskId: string,
  observedAt: string,
  context: ScenarioEpisodeContext,
  toEpisodeConfidence: (text: string) => number
): ScenarioEpisodeCandidateInput | null {
  const revisitMatch = EPISODE_MAY_REVISIT_PATTERN.exec(sentence);
  if (revisitMatch) {
    const rawSubject = trimTrailingClausePunctuation(revisitMatch[1] ?? "");
    const contactToken = extractEpisodeContactToken(rawSubject) ??
      (normalizeEpisodeSurface(rawSubject).toLowerCase() === "he" ? context.lastMoveContactToken : null);
    const topicSurface = normalizeEpisodeSurface(
      trimTrailingClausePunctuation(revisitMatch[2] ?? "")
    );
    if (
      contactToken &&
      topicSurface &&
      (/\bmov/i.test(topicSurface) || topicSurface.toLowerCase().startsWith("that "))
    ) {
      return {
        title: `${displayNameFromContactToken(contactToken)} possible move`,
        summary: trimTrailingClausePunctuation(sentence),
        sourceTaskId,
        observedAt,
        confidence: toEpisodeConfidence(sentence),
        entityRefs: [`contact.${contactToken}`],
        status: "outcome_unknown",
        tags: ["move", "planning", "tentative"]
      };
    }
  }

  const normalizedSentence = sentence.toLowerCase();
  if (context.lastMoveContactToken && normalizedSentence.includes("may revisit that")) {
    return {
      title: `${displayNameFromContactToken(context.lastMoveContactToken)} possible move`,
      summary: trimTrailingClausePunctuation(sentence),
      sourceTaskId,
      observedAt,
      confidence: toEpisodeConfidence(sentence),
      entityRefs: [`contact.${context.lastMoveContactToken}`],
      status: "outcome_unknown",
      tags: ["move", "planning", "tentative"]
    };
  }

  const moveMatch = EPISODE_MAY_MOVE_PATTERN.exec(sentence);
  if (!moveMatch) {
    return null;
  }

  const contactToken = extractEpisodeContactToken(
    trimTrailingClausePunctuation(moveMatch[1] ?? "")
  );
  if (!contactToken) {
    return null;
  }

  return {
    title: `${displayNameFromContactToken(contactToken)} possible move`,
    summary: trimTrailingClausePunctuation(sentence),
    sourceTaskId,
    observedAt,
    confidence: toEpisodeConfidence(sentence),
    entityRefs: [`contact.${contactToken}`],
    status: "outcome_unknown",
    tags: ["move", "planning", "tentative"]
  };
}

/**
 * Trims transfer episode object surface.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `normalizeProfileValue` (import `normalizeProfileValue`) from `./profileMemoryNormalization`.
 * @param rawObject - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function trimTransferEpisodeObjectSurface(rawObject: string): string {
  const withoutTrailingTime = rawObject.replace(
    /\s+in\s+(?:late|early|mid)?\s*[A-Za-z0-9' -]+$/i,
    ""
  );
  return normalizeProfileValue(withoutTrailingTime);
}

/**
 * Records scenario episode candidate.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `CreateProfileEpisodeRecordInput` (import `CreateProfileEpisodeRecordInput`) from `./profileMemoryEpisodeContracts`.
 * @param candidate - Input consumed by this helper.
 * @param seen - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function recordScenarioEpisodeCandidate(
  candidate: ScenarioEpisodeCandidateInput,
  seen: Set<string>
): CreateProfileEpisodeRecordInput | null {
  const normalizedTitle = normalizeEpisodeSurface(candidate.title);
  const entityRefs = normalizeScenarioEntityRefs(candidate.entityRefs);
  if (!normalizedTitle || entityRefs.length === 0) {
    return null;
  }

  const signature = `${entityRefs.join("|")}::${normalizedTitle.toLowerCase()}`;
  if (seen.has(signature)) {
    return null;
  }
  seen.add(signature);

  return {
    title: normalizedTitle,
    summary: candidate.summary,
    sourceTaskId: candidate.sourceTaskId,
    source: "user_input_pattern.episode_candidate",
    sourceKind: "explicit_user_statement",
    sensitive: false,
    observedAt: candidate.observedAt,
    confidence: candidate.confidence,
    status: candidate.status,
    entityRefs,
    tags: candidate.tags
  };
}

/**
 * Normalizes scenario entity refs.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param entityRefs - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function normalizeScenarioEntityRefs(entityRefs: readonly string[]): string[] {
  return [...new Set(
    entityRefs
      .map((value) => normalizeEpisodeSurface(value))
      .filter((value) => value.length > 0)
  )];
}

/**
 * Normalizes episode surface.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `normalizeProfileValue` (import `normalizeProfileValue`) from `./profileMemoryNormalization`.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function normalizeEpisodeSurface(value: string): string {
  return normalizeProfileValue(value)
    .replace(/^[Tt]he\s+/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Strips leading date surface.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function stripLeadingDateSurface(value: string): string {
  return normalizeEpisodeSurface(value).replace(
    /^(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\s+/u,
    ""
  );
}

/**
 * Extracts episode contact token.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `normalizeProfileKey` (import `normalizeProfileKey`) from `./profileMemoryNormalization`.
 * - Uses `trimTrailingClausePunctuation` (import `trimTrailingClausePunctuation`) from `./profileMemoryNormalization`.
 * @param rawName - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function extractEpisodeContactToken(rawName: string): string | null {
  const candidates = [...rawName.matchAll(EPISODE_NAME_CANDIDATE_PATTERN)]
    .map((match) => trimTrailingClausePunctuation(match[0] ?? ""))
    .filter((candidate) => candidate.length > 0)
    .filter((candidate) => !EPISODE_NAME_STOP_WORDS.has(candidate));
  if (candidates.length === 0) {
    return null;
  }
  return normalizeProfileKey(candidates[candidates.length - 1] ?? "");
}
