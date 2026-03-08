/**
 * @fileoverview Normalizes bounded language-understanding episode output into canonical profile-memory candidates.
 */

import {
  type CreateProfileEpisodeRecordInput,
  clampProfileEpisodeConfidence,
  normalizeProfileKey,
  normalizeProfileValue
} from "../../core/profileMemory";
import { displayNameFromContactToken } from "../../core/profileMemoryRuntime/profileMemoryNormalization";
import type {
  LanguageEpisodeExtractionModelCandidate,
  LanguageUnderstandingEpisodeExtractionRequest
} from "./contracts";
import { MAX_LANGUAGE_EPISODE_CANDIDATES } from "./contracts";

/**
 * Normalizes model-assisted episode candidates into bounded profile-memory episode records.
 *
 * @param candidates - Raw structured model output candidates.
 * @param request - Source extraction request metadata.
 * @returns Canonical profile-memory episode candidates.
 */
export function normalizeLanguageEpisodeCandidates(
  candidates: readonly LanguageEpisodeExtractionModelCandidate[],
  request: LanguageUnderstandingEpisodeExtractionRequest
): CreateProfileEpisodeRecordInput[] {
  const normalized: CreateProfileEpisodeRecordInput[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates.slice(0, MAX_LANGUAGE_EPISODE_CANDIDATES)) {
    const subjectName = normalizeProfileValue(candidate.subjectName);
    const contactToken = normalizeProfileKey(subjectName);
    const eventSummary = normalizeEventSummary(candidate.eventSummary);
    const supportingSnippet = normalizeProfileValue(candidate.supportingSnippet);
    if (!contactToken || !eventSummary || !supportingSnippet) {
      continue;
    }

    const displayName = displayNameFromContactToken(contactToken);
    const title = eventSummary.toLowerCase().startsWith(displayName.toLowerCase())
      ? eventSummary
      : `${displayName} ${eventSummary}`;
    const signature = `${contactToken}::${eventSummary.toLowerCase()}`;
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);

    const tags = normalizeTags(candidate.tags);
    normalized.push({
      title,
      summary: supportingSnippet,
      sourceTaskId: request.sourceTaskId,
      source: "language_understanding.episode_extraction",
      sourceKind: "assistant_inference",
      sensitive: false,
      observedAt: request.observedAt,
      confidence: clampProfileEpisodeConfidence(candidate.confidence),
      status: candidate.status,
      entityRefs: [`contact.${contactToken}`],
      tags
    });
  }

  return normalized;
}

/**
 * Normalizes one event summary into a compact phrase suitable for episode titles.
 *
 * @param value - Raw event summary from model output.
 * @returns Normalized event-summary phrase.
 */
function normalizeEventSummary(value: string): string {
  const normalized = normalizeProfileValue(value)
    .replace(/[.!?]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized;
}

/**
 * Normalizes tag strings into a stable lowercase deduplicated set.
 *
 * @param tags - Raw tag values.
 * @returns Canonical tag collection.
 */
function normalizeTags(tags: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const tag of tags) {
    const value = normalizeProfileValue(tag).toLowerCase();
    if (!value) {
      continue;
    }
    normalized.add(value);
  }
  return [...normalized].sort((left, right) => left.localeCompare(right));
}
