/**
 * @fileoverview Bounded model-fallback helpers for structured episode understanding.
 */

import type { ModelClient } from "../../models/types";
import type {
  LanguageEpisodeExtractionModelOutput,
  LanguageUnderstandingEpisodeExtractionRequest
} from "./contracts";
import {
  DEFAULT_LANGUAGE_UNDERSTANDING_MODEL,
  LANGUAGE_EPISODE_EXTRACTION_SCHEMA_NAME
} from "./contracts";

/**
 * Requests bounded structured episode extraction from the active model client.
 *
 * @param modelClient - Structured model client dependency.
 * @param request - Extraction request.
 * @returns Structured model output, or `null` when model assistance fails.
 */
export async function extractEpisodeCandidatesWithModelFallback(
  modelClient: ModelClient,
  request: LanguageUnderstandingEpisodeExtractionRequest
): Promise<LanguageEpisodeExtractionModelOutput | null> {
  try {
    return await modelClient.completeJson<LanguageEpisodeExtractionModelOutput>({
      model: request.model ?? DEFAULT_LANGUAGE_UNDERSTANDING_MODEL,
      schemaName: LANGUAGE_EPISODE_EXTRACTION_SCHEMA_NAME,
      systemPrompt: [
        "You extract at most two concrete human situations from one user message.",
        "Only return situations that are clearly grounded in the text.",
        "Prefer situations involving a named person/contact and an unresolved or update-worthy outcome.",
        "Keep eventSummary short, natural, and noun/verb phrase style.",
        "Use supportingSnippet as an exact short snippet from the user text when possible.",
        "Return no episodes when the text does not clearly describe a rememberable situation."
      ].join(" "),
      userPrompt: JSON.stringify({
        text: request.text
      })
    });
  } catch {
    return null;
  }
}
