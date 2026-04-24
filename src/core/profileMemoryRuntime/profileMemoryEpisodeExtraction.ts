/**
 * @fileoverview Deterministic episodic-memory extraction from raw user input.
 */

import type { CreateProfileEpisodeRecordInput } from "./profileMemoryEpisodeContracts";
import {
  createScenarioEpisodeContext,
  extractPatternEpisodeCandidate,
  extractScenarioEpisodeCandidate,
  extractTransferEpisodeCandidate,
  splitIntoEpisodeSentences,
  updateScenarioEpisodeContext
} from "./profileMemoryEpisodeScenarioSupport";

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
  const sentences = splitIntoEpisodeSentences(userInput);
  if (sentences.length === 0) {
    return [];
  }

  const candidates: CreateProfileEpisodeRecordInput[] = [];
  const seen = new Set<string>();
  const scenarioContext = createScenarioEpisodeContext();

  for (const sentence of sentences) {
    updateScenarioEpisodeContext(scenarioContext, sentence);

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

    const scenarioCandidate = extractScenarioEpisodeCandidate(
      sentence,
      sourceTaskId,
      observedAt,
      seen,
      scenarioContext
    );
    if (scenarioCandidate) {
      candidates.push(scenarioCandidate);
      continue;
    }

    const patternCandidate = extractPatternEpisodeCandidate(
      sentence,
      sourceTaskId,
      observedAt,
      seen
    );
    if (patternCandidate) {
      candidates.push(patternCandidate);
    }
  }

  return candidates;
}
