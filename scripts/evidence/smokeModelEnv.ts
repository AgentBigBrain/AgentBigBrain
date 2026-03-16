/**
 * @fileoverview Prefers a governed local planner backend for evidence smokes when Ollama is ready.
 */

import type {
  LocalIntentModelRuntimeProbeResult
} from "../../src/organs/languageUnderstanding/localIntentModelRuntime";

export interface SmokeModelBackendSelection {
  backend: "existing" | "ollama";
  envOverrides: Record<string, string>;
}

/**
 * Builds smoke-only model env overrides from the current local-intent probe state.
 *
 * **Why it exists:**
 * Front-door live smokes should keep using the governed runtime, but they should not stay blocked
 * on OpenAI quota when the same machine already has a local Ollama model ready.
 *
 * **What it talks to:**
 * - Uses the existing local-intent probe result as a bounded signal for local Ollama readiness.
 *
 * @param probe - Local-intent runtime probe result for the current machine.
 * @returns Backend selection plus any env overrides needed for the smoke run.
 */
export function buildSmokeModelEnvOverrides(
  probe: Pick<
    LocalIntentModelRuntimeProbeResult,
    "provider" | "reachable" | "modelPresent" | "model"
  >
): SmokeModelBackendSelection {
  const currentBackend = (process.env.BRAIN_MODEL_BACKEND ?? "").trim().toLowerCase();
  const preferLocalBackend =
    (process.env.BRAIN_LIVE_SMOKE_PREFER_LOCAL_MODEL ?? "").trim().toLowerCase() === "true";
  const shouldUseLocalBackend = currentBackend === "ollama" || preferLocalBackend;

  if (!shouldUseLocalBackend) {
    return {
      backend: "existing",
      envOverrides: {}
    };
  }

  if (
    probe.provider === "ollama" &&
    probe.reachable &&
    probe.modelPresent &&
    probe.model.trim().length > 0
  ) {
    return {
      backend: "ollama",
      envOverrides: {
        BRAIN_MODEL_BACKEND: "ollama",
        OLLAMA_MODEL_DEFAULT: probe.model,
        OLLAMA_MODEL_SMALL_FAST: probe.model,
        OLLAMA_MODEL_SMALL_POLICY: probe.model,
        OLLAMA_MODEL_MEDIUM_GENERAL: probe.model,
        OLLAMA_MODEL_MEDIUM_POLICY: probe.model,
        OLLAMA_MODEL_LARGE_REASONING: probe.model
      }
    };
  }

  return {
    backend: "existing",
    envOverrides: {}
  };
}
