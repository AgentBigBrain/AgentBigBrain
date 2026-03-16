/**
 * @fileoverview Canonical Ollama model alias helpers.
 */

export interface ResolvedOllamaModel {
  requestedModel: string;
  aliasModel: string | null;
  providerModel: string;
}

const OLLAMA_MODEL_ALIAS_ENV: Record<string, string> = {
  "small-fast-model": "OLLAMA_MODEL_SMALL_FAST",
  "small-policy-model": "OLLAMA_MODEL_SMALL_POLICY",
  "medium-general-model": "OLLAMA_MODEL_MEDIUM_GENERAL",
  "medium-policy-model": "OLLAMA_MODEL_MEDIUM_POLICY",
  "large-reasoning-model": "OLLAMA_MODEL_LARGE_REASONING"
};

/**
 * Resolves a safe provider model fallback when an Ollama alias env override is missing.
 *
 * **Why it exists:**
 * Ollama does not understand AgentBigBrain's logical model aliases. This helper keeps alias
 * resolution deterministic and fail-closed instead of leaking alias names directly to the local
 * provider.
 *
 * **What it talks to:**
 * - `OLLAMA_MODEL_DEFAULT` and `OLLAMA_MODEL_*` environment variables.
 *
 * @param alias - Requested model alias (for example `large-reasoning-model`).
 * @param env - Environment values used for local-provider resolution.
 * @returns Concrete local model tag for the alias.
 */
export function defaultOllamaModelForAlias(
  alias: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const configuredDefault = env.OLLAMA_MODEL_DEFAULT?.trim();
  if (configuredDefault) {
    return configuredDefault;
  }

  throw new Error(
    `Ollama model alias "${alias}" requires ${OLLAMA_MODEL_ALIAS_ENV[alias] ?? "an explicit mapping"} ` +
    "or OLLAMA_MODEL_DEFAULT to be configured."
  );
}

/**
 * Resolves logical model labels into concrete Ollama model ids.
 *
 * **Why it exists:**
 * Planner and governor routing use stable aliases, while Ollama requires a real model tag.
 *
 * **What it talks to:**
 * - `OLLAMA_MODEL_ALIAS_ENV` for alias-to-env mapping.
 * - `defaultOllamaModelForAlias` for fail-closed default resolution.
 *
 * @param modelLabel - Model label selected by routing logic.
 * @param env - Environment values used for local-provider resolution.
 * @returns Requested alias context plus final Ollama model id.
 */
export function resolveOllamaModel(
  modelLabel: string,
  env: NodeJS.ProcessEnv = process.env
): ResolvedOllamaModel {
  const envKey = OLLAMA_MODEL_ALIAS_ENV[modelLabel];
  if (!envKey) {
    return {
      requestedModel: modelLabel,
      aliasModel: null,
      providerModel: modelLabel
    };
  }

  const envModel = env[envKey]?.trim();
  if (envModel) {
    return {
      requestedModel: modelLabel,
      aliasModel: modelLabel,
      providerModel: envModel
    };
  }

  return {
    requestedModel: modelLabel,
    aliasModel: modelLabel,
    providerModel: defaultOllamaModelForAlias(modelLabel, env)
  };
}
