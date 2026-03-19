/**
 * @fileoverview Resolves bounded provider auth for media-understanding requests.
 */

import { readCodexBearerToken } from "../../models/codex/authStore";
import type { MediaUnderstandingConfig } from "./contracts";

/**
 * Resolves the bearer token used for one provider-backed media-understanding request.
 *
 * @param config - Media-understanding runtime configuration.
 * @returns Bearer token for the configured backend, or `null` when provider auth is unavailable.
 */
export async function resolveMediaAuthorizationToken(
  config: MediaUnderstandingConfig
): Promise<string | null> {
  if (config.resolvedBackend === "openai_api") {
    return config.openAIApiKey;
  }
  if (config.resolvedBackend === "codex_oauth") {
    return await readCodexBearerToken(config.env ?? process.env);
  }
  return null;
}

/**
 * Returns the provider label used in provenance text for media-understanding calls.
 *
 * @param config - Media-understanding runtime configuration.
 * @returns Stable provider label for bounded provenance strings.
 */
export function describeMediaAuthorizationSource(
  config: MediaUnderstandingConfig
): string {
  return config.resolvedBackend === "codex_oauth"
    ? "Codex OAuth-backed OpenAI"
    : "OpenAI";
}
