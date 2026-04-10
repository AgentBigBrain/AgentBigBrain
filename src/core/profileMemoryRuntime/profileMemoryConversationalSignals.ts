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
  return extractProfileEpisodeCandidatesFromUserInput(
    userInput,
    SIGNAL_ASSESSMENT_SOURCE_TASK_ID,
    SIGNAL_ASSESSMENT_OBSERVED_AT
  ).length > 0;
}
