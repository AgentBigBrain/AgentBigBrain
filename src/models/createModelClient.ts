/**
 * @fileoverview Creates the runtime model client backend from environment configuration.
 */

import { ModelClient } from "./types";
import { MockModelClient } from "./mockModelClient";
import { OllamaModelClient } from "./ollamaModelClient";
import { OpenAIModelClient } from "./openaiModelClient";
import {
  parseOpenAICompatibilityStrict,
  parseOpenAITransportMode
} from "./openai/modelProfiles";
import { buildOpenAIPricingFromEnv } from "./openai/pricingPolicy";
import { ensureEnvLoaded } from "../core/envLoader";

/**
 * Normalizes backend into a stable shape for `createModelClient` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for backend so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function normalizeBackend(value: string | undefined): string {
  return (value ?? "mock").trim().toLowerCase();
}

/**
 * Parses timeout ms and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for timeout ms so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fallback - Value for fallback.
 * @returns Computed numeric value.
 */
function parseTimeoutMs(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

/**
 * Parses boolean env and validates expected structure.
 *
 * **Why it exists:**
 * Keeps OpenAI compatibility-mode bootstrap logic aligned with the rest of the env reader without
 * spreading boolean parsing rules across the file.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns `true` when the env value enables the feature.
 */
function parseBoolean(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}

/**
 * Builds model client from env for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of model client from env consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `ensureEnvLoaded` (import `ensureEnvLoaded`) from `../core/envLoader`.
 * - Uses `MockModelClient` (import `MockModelClient`) from `./mockModelClient`.
 * - Uses `OllamaModelClient` (import `OllamaModelClient`) from `./ollamaModelClient`.
 * - Uses `OpenAIModelClient` (import `OpenAIModelClient`) from `./openaiModelClient`.
 * - Uses `ModelClient` (import `ModelClient`) from `./types`.
 * @returns Computed `ModelClient` result.
 */
export function createModelClientFromEnv(): ModelClient {
  ensureEnvLoaded();
  const backend = normalizeBackend(process.env.BRAIN_MODEL_BACKEND);

  if (backend === "ollama") {
    return new OllamaModelClient({
      baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
      requestTimeoutMs: parseTimeoutMs(process.env.OLLAMA_TIMEOUT_MS, 60_000)
    });
  }

  if (backend === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "BRAIN_MODEL_BACKEND=openai requested but OPENAI_API_KEY is missing."
      );
    }

    const pricing = buildOpenAIPricingFromEnv(process.env);
    return new OpenAIModelClient({
      apiKey,
      baseUrl: process.env.OPENAI_BASE_URL,
      requestTimeoutMs: parseTimeoutMs(process.env.OPENAI_TIMEOUT_MS, 120_000),
      defaultPricing: pricing.defaultPricing,
      aliasPricing: pricing.aliasPricing,
      transportMode: parseOpenAITransportMode(process.env.OPENAI_TRANSPORT_MODE),
      compatibilityStrict:
        process.env.OPENAI_COMPATIBILITY_STRICT === undefined
          ? false
          : parseOpenAICompatibilityStrict(process.env.OPENAI_COMPATIBILITY_STRICT),
      allowJsonObjectCompatibilityFallback:
        process.env.OPENAI_ALLOW_JSON_OBJECT_COMPAT_FALLBACK === undefined
          ? false
          : parseBoolean(process.env.OPENAI_ALLOW_JSON_OBJECT_COMPAT_FALLBACK)
    });
  }

  return new MockModelClient();
}
