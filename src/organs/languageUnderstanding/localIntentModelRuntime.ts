/**
 * @fileoverview Parses environment-backed local intent-model config and creates the optional bounded resolver.
 */

import { ensureEnvLoaded } from "../../core/envLoader";
import type { LocalIntentModelResolver } from "./localIntentModelContracts";
import {
  createOllamaLocalIntentModelResolver,
  probeOllamaLocalIntentModel,
  type OllamaLocalIntentModelProbeResult
} from "./ollamaLocalIntentModel";

export type LocalIntentModelProvider = "ollama";

export interface LocalIntentModelRuntimeConfig {
  enabled: boolean;
  provider: LocalIntentModelProvider;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  liveSmokeRequired: boolean;
}

export interface LocalIntentModelRuntimeProbeResult {
  enabled: boolean;
  provider: LocalIntentModelProvider;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  liveSmokeRequired: boolean;
  reachable: boolean;
  modelPresent: boolean;
  availableModels: readonly string[];
}

interface LocalIntentModelRuntimeDependencies {
  fetchImpl?: typeof fetch;
}

/**
 * Parses permissive boolean env values used by the local intent-model runtime.
 *
 * @param value - Raw env value.
 * @param fallback - Default value when the env is unset or invalid.
 * @returns Parsed boolean flag.
 */
function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

/**
 * Parses a positive integer env value used by local intent-model config.
 *
 * @param value - Raw env value.
 * @param fallback - Default value when the env is unset or invalid.
 * @returns Parsed positive integer.
 */
function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

/**
 * Builds the env-backed local intent-model runtime config.
 *
 * @param env - Environment source used for configuration.
 * @returns Normalized local intent-model runtime config.
 */
export function createLocalIntentModelRuntimeConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): LocalIntentModelRuntimeConfig {
  if (env === process.env) {
    ensureEnvLoaded();
  }
  const provider = ((env.BRAIN_LOCAL_INTENT_MODEL_PROVIDER ?? "ollama").trim().toLowerCase()
    || "ollama") as LocalIntentModelProvider;
  if (provider !== "ollama") {
    throw new Error(
      "BRAIN_LOCAL_INTENT_MODEL_PROVIDER must currently be 'ollama'."
    );
  }
  return {
    enabled: parseBoolean(env.BRAIN_LOCAL_INTENT_MODEL_ENABLED, false),
    provider,
    baseUrl: (env.BRAIN_LOCAL_INTENT_MODEL_BASE_URL ?? "http://127.0.0.1:11434").trim(),
    model: (env.BRAIN_LOCAL_INTENT_MODEL_NAME ?? "phi4-mini:latest").trim(),
    timeoutMs: parsePositiveInteger(env.BRAIN_LOCAL_INTENT_MODEL_TIMEOUT_MS, 45000),
    liveSmokeRequired: parseBoolean(env.BRAIN_LOCAL_INTENT_MODEL_LIVE_SMOKE_REQUIRED, false)
  };
}

/**
 * Creates the optional local intent-model resolver from env.
 *
 * @param env - Environment source used for configuration.
 * @param deps - Optional dependency overrides for tests.
 * @returns Configured resolver when enabled, otherwise `undefined`.
 */
export function createLocalIntentModelResolverFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: LocalIntentModelRuntimeDependencies = {}
): LocalIntentModelResolver | undefined {
  const config = createLocalIntentModelRuntimeConfigFromEnv(env);
  if (!config.enabled) {
    return undefined;
  }
  return createOllamaLocalIntentModelResolver(config, deps);
}

/**
 * Probes the local intent-model runtime from env without routing any user input.
 *
 * @param env - Environment source used for configuration.
 * @param deps - Optional dependency overrides for tests.
 * @returns Local intent-model readiness probe result.
 */
export async function probeLocalIntentModelFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: LocalIntentModelRuntimeDependencies = {}
): Promise<LocalIntentModelRuntimeProbeResult> {
  const config = createLocalIntentModelRuntimeConfigFromEnv(env);
  if (!config.enabled) {
    return {
      ...config,
      reachable: false,
      modelPresent: false,
      availableModels: []
    };
  }
  const probe = await probeOllamaLocalIntentModel(config, deps);
  return {
    ...config,
    ...probe
  };
}

/**
 * Returns `true` when the probed local intent-model runtime is ready for live routing.
 *
 * @param probe - Probe result subset describing transport reachability and model presence.
 * @returns `true` when the local runtime can safely serve intent requests.
 */
export function isLocalIntentModelRuntimeReady(
  probe: Pick<OllamaLocalIntentModelProbeResult, "reachable" | "modelPresent">
): boolean {
  return probe.reachable && probe.modelPresent;
}
