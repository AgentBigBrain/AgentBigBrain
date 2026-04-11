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
const QUESTION_SHAPE_PATTERN =
  /[?\u00bf]|^\s*(?:who|what|when|where|why|how|do|does|did|is|are|was|were|can|could|would|should)\b/i;
const WORKFLOW_OR_STATUS_CUE_PATTERN =
  /\b(?:build|deploy|run|open|close|resume|continue|status|review|preview|browser|workspace|repo|project)\b/i;
const RELATIONSHIP_UPDATE_MARKER_PATTERN =
  /\b(?:used to|previously|formerly|no longer|anymore|worked with|work with|works with|now works|works somewhere else|someone i worked)\b/i;
const NAMED_CONTACT_UPDATE_PATTERN =
  /\b[A-Z][A-Za-z'.-]{1,30}\b[\s\S]{0,120}\b(?:used to|previously|formerly|no longer|worked|works)\b/i;

/**
 * Returns whether bounded third-person relationship update wording should count as conversational
 * profile memory even when the deterministic extractors do not yet emit a concrete fact or episode
 * candidate from the same sentence shape.
 *
 * @param userInput - Raw user utterance under analysis.
 * @returns `true` when the wording looks like a factual relationship update rather than recall.
 */
function hasRelationshipNarrativeUpdateSignal(userInput: string): boolean {
  const normalized = userInput.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  if (QUESTION_SHAPE_PATTERN.test(normalized)) {
    return false;
  }
  if (WORKFLOW_OR_STATUS_CUE_PATTERN.test(normalized)) {
    return false;
  }
  return (
    RELATIONSHIP_UPDATE_MARKER_PATTERN.test(normalized) &&
    NAMED_CONTACT_UPDATE_PATTERN.test(normalized)
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
