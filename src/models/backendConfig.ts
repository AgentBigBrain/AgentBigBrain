/**
 * @fileoverview Normalizes model-backend configuration and preserves the legacy `openai` alias.
 */

import type { ModelBackend } from "./types";

export const LEGACY_OPENAI_BACKEND_ALIAS = "openai";

/**
 * Resolves the configured backend into one canonical runtime value.
 *
 * @param value - Raw backend environment value.
 * @returns Canonical backend identifier.
 */
export function normalizeModelBackend(value: string | undefined): ModelBackend {
  const normalized = (value ?? "mock").trim().toLowerCase();
  if (normalized === "" || normalized === "mock") {
    return "mock";
  }
  if (normalized === "ollama") {
    return "ollama";
  }
  if (normalized === LEGACY_OPENAI_BACKEND_ALIAS || normalized === "openai_api") {
    return "openai_api";
  }
  if (normalized === "codex_oauth") {
    return "codex_oauth";
  }
  throw new Error(
    `Unsupported BRAIN_MODEL_BACKEND="${value ?? ""}". ` +
    "Expected one of mock, ollama, openai_api, codex_oauth, or legacy alias openai."
  );
}

/**
 * Resolves the backend env into a canonical runtime value for the current process.
 *
 * @param env - Environment source used for backend resolution.
 * @returns Canonical backend identifier.
 */
export function resolveModelBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ModelBackend {
  return normalizeModelBackend(env.BRAIN_MODEL_BACKEND);
}
