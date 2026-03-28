/**
 * @fileoverview Resolves bounded provider auth for media-understanding requests.
 */

import { readCodexBearerToken } from "../../models/codex/authStore";
import type {
  MediaUnderstandingConfig,
  MediaUnderstandingModality
} from "./contracts";

/**
 * Resolves the effective provider backend for one media-understanding modality.
 *
 * @param config - Media-understanding runtime configuration.
 * @param modality - Target media-understanding modality.
 * @returns Resolved backend used by that modality.
 */
function resolveMediaBackendForModality(
  config: MediaUnderstandingConfig,
  modality: MediaUnderstandingModality
): MediaUnderstandingConfig["resolvedBackend"] {
  return modality === "vision"
    ? config.resolvedVisionBackend
    : config.resolvedTranscriptionBackend;
}

/**
 * Resolves the bearer token used for one provider-backed media-understanding request.
 *
 * @param config - Media-understanding runtime configuration.
 * @param modality - Media-understanding modality using the provider auth path.
 * @returns Bearer token for the configured backend, or `null` when provider auth is unavailable.
 */
export async function resolveMediaAuthorizationToken(
  config: MediaUnderstandingConfig,
  modality: MediaUnderstandingModality
): Promise<string | null> {
  const resolvedBackend = resolveMediaBackendForModality(config, modality);
  if (resolvedBackend === "openai_api") {
    return config.openAIApiKey;
  }
  if (resolvedBackend === "codex_oauth") {
    return await readCodexBearerToken(config.env ?? process.env);
  }
  return null;
}

/**
 * Returns the provider label used in provenance text for media-understanding calls.
 *
 * @param config - Media-understanding runtime configuration.
 * @param modality - Media-understanding modality using the provider auth path.
 * @returns Stable provider label for bounded provenance strings.
 */
export function describeMediaAuthorizationSource(
  config: MediaUnderstandingConfig,
  modality: MediaUnderstandingModality
): string {
  return resolveMediaBackendForModality(config, modality) === "codex_oauth"
    ? "Codex OAuth-backed OpenAI"
    : "OpenAI";
}
