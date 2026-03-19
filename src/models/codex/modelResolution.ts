/**
 * @fileoverview Canonical Codex model alias resolution and supported-model allowlist.
 */

import type { ResolvedCodexModel } from "./contracts";

const CODEX_MODEL_ALIAS_ENV: Record<string, string> = {
  "small-fast-model": "CODEX_MODEL_SMALL_FAST",
  "small-policy-model": "CODEX_MODEL_SMALL_POLICY",
  "medium-general-model": "CODEX_MODEL_MEDIUM_GENERAL",
  "medium-policy-model": "CODEX_MODEL_MEDIUM_POLICY",
  "large-reasoning-model": "CODEX_MODEL_LARGE_REASONING"
};

const DEFAULT_CODEX_ALIAS_MODELS: Record<string, string> = {
  "small-fast-model": "gpt-5.4-mini",
  "small-policy-model": "gpt-5.4-mini",
  "medium-general-model": "gpt-5.4-mini",
  "medium-policy-model": "gpt-5.4-mini",
  "large-reasoning-model": "gpt-5.4"
};

const SUPPORTED_CODEX_MODELS = new Set<string>([
  "gpt-5.4-mini",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini"
]);

/**
 * Returns the canonical fallback provider model for one Codex alias.
 *
 * @param alias - Requested model alias.
 * @returns Provider model id to use for that alias.
 */
export function defaultCodexModelForAlias(alias: string): string {
  return DEFAULT_CODEX_ALIAS_MODELS[alias] ?? alias;
}

/**
 * Returns true when a provider model is supported by the Codex backend allowlist.
 *
 * @param model - Concrete provider model id.
 * @returns True when the model is explicitly supported.
 */
export function isSupportedCodexModel(model: string): boolean {
  return SUPPORTED_CODEX_MODELS.has(model.trim());
}

/**
 * Resolves a logical model label into a supported Codex provider model id.
 *
 * @param modelLabel - Model label selected by routing logic.
 * @param env - Environment source for alias overrides.
 * @returns Requested alias metadata plus final provider model id.
 */
export function resolveCodexModel(
  modelLabel: string,
  env: NodeJS.ProcessEnv = process.env
): ResolvedCodexModel {
  const envKey = CODEX_MODEL_ALIAS_ENV[modelLabel];
  const providerModel = (() => {
    if (!envKey) {
      return modelLabel.trim();
    }
    const envModel = env[envKey];
    if (typeof envModel === "string" && envModel.trim().length > 0) {
      return envModel.trim();
    }
    return defaultCodexModelForAlias(modelLabel);
  })();

  if (!isSupportedCodexModel(providerModel)) {
    throw new Error(
      `Codex backend does not support provider model "${providerModel}" for "${modelLabel}".`
    );
  }

  return {
    requestedModel: modelLabel,
    aliasModel: envKey ? modelLabel : null,
    providerModel
  };
}
