/**
 * @fileoverview Stable entrypoint for bounded model-assisted episode extraction.
 */

import type { ModelClient } from "../../models/types";
import type { CreateProfileEpisodeRecordInput } from "../../core/profileMemory";
import type { LanguageUnderstandingEpisodeExtractionRequest } from "./contracts";
import { normalizeLanguageEpisodeCandidates } from "./episodeNormalization";
import { extractEpisodeCandidatesWithModelFallback } from "./languageModelFallback";

export class LanguageUnderstandingOrgan {
  /**
   * Initializes `LanguageUnderstandingOrgan` with the shared structured model client.
   *
   * @param modelClient - Model client used for bounded structured extraction.
   */
  constructor(private readonly modelClient: ModelClient) {}

  /**
   * Extracts bounded model-assisted episode candidates from a user utterance.
   *
   * @param request - Episode extraction request.
   * @returns Canonical profile-memory episode candidates, or an empty list on failure.
   */
  async extractEpisodeCandidates(
    request: LanguageUnderstandingEpisodeExtractionRequest
  ): Promise<CreateProfileEpisodeRecordInput[]> {
    if (!request.text.trim()) {
      return [];
    }

    const modelOutput = await extractEpisodeCandidatesWithModelFallback(this.modelClient, request);
    if (!modelOutput) {
      return [];
    }
    return normalizeLanguageEpisodeCandidates(modelOutput.episodes, request);
  }
}
