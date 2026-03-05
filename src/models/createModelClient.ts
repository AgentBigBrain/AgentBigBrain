/**
 * @fileoverview Creates the runtime model client backend from environment configuration.
 */

import { ModelClient } from "./types";
import { MockModelClient } from "./mockModelClient";
import { OllamaModelClient } from "./ollamaModelClient";
import { OpenAIModelClient } from "./openaiModelClient";
import { ensureEnvLoaded } from "../core/envLoader";

interface TokenPricing {
  inputPer1MUsd: number;
  outputPer1MUsd: number;
}

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
 * Parses non negative number and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for non negative number so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fallback - Value for fallback.
 * @returns Computed numeric value.
 */
function parseNonNegativeNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

/**
 * Builds pricing from env for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of pricing from env consistent across call sites.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param env - Value for env.
 * @returns Computed `{
  defaultPricing: TokenPricing;
  aliasPricing: Record<string, TokenPricing>;
}` result.
 */
function buildPricingFromEnv(env: NodeJS.ProcessEnv): {
  defaultPricing: TokenPricing;
  aliasPricing: Record<string, TokenPricing>;
} {
  const defaultPricing: TokenPricing = {
    inputPer1MUsd: parseNonNegativeNumber(env.OPENAI_PRICE_INPUT_PER_1M_USD, 0),
    outputPer1MUsd: parseNonNegativeNumber(env.OPENAI_PRICE_OUTPUT_PER_1M_USD, 0)
  };

  const aliasPricing: Record<string, TokenPricing> = {
    "small-fast-model": {
      inputPer1MUsd: parseNonNegativeNumber(
        env.OPENAI_PRICE_SMALL_FAST_INPUT_PER_1M_USD,
        defaultPricing.inputPer1MUsd
      ),
      outputPer1MUsd: parseNonNegativeNumber(
        env.OPENAI_PRICE_SMALL_FAST_OUTPUT_PER_1M_USD,
        defaultPricing.outputPer1MUsd
      )
    },
    "small-policy-model": {
      inputPer1MUsd: parseNonNegativeNumber(
        env.OPENAI_PRICE_SMALL_POLICY_INPUT_PER_1M_USD,
        defaultPricing.inputPer1MUsd
      ),
      outputPer1MUsd: parseNonNegativeNumber(
        env.OPENAI_PRICE_SMALL_POLICY_OUTPUT_PER_1M_USD,
        defaultPricing.outputPer1MUsd
      )
    },
    "medium-general-model": {
      inputPer1MUsd: parseNonNegativeNumber(
        env.OPENAI_PRICE_MEDIUM_GENERAL_INPUT_PER_1M_USD,
        defaultPricing.inputPer1MUsd
      ),
      outputPer1MUsd: parseNonNegativeNumber(
        env.OPENAI_PRICE_MEDIUM_GENERAL_OUTPUT_PER_1M_USD,
        defaultPricing.outputPer1MUsd
      )
    },
    "medium-policy-model": {
      inputPer1MUsd: parseNonNegativeNumber(
        env.OPENAI_PRICE_MEDIUM_POLICY_INPUT_PER_1M_USD,
        defaultPricing.inputPer1MUsd
      ),
      outputPer1MUsd: parseNonNegativeNumber(
        env.OPENAI_PRICE_MEDIUM_POLICY_OUTPUT_PER_1M_USD,
        defaultPricing.outputPer1MUsd
      )
    },
    "large-reasoning-model": {
      inputPer1MUsd: parseNonNegativeNumber(
        env.OPENAI_PRICE_LARGE_REASONING_INPUT_PER_1M_USD,
        defaultPricing.inputPer1MUsd
      ),
      outputPer1MUsd: parseNonNegativeNumber(
        env.OPENAI_PRICE_LARGE_REASONING_OUTPUT_PER_1M_USD,
        defaultPricing.outputPer1MUsd
      )
    }
  };

  return {
    defaultPricing,
    aliasPricing
  };
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

    const pricing = buildPricingFromEnv(process.env);
    return new OpenAIModelClient({
      apiKey,
      baseUrl: process.env.OPENAI_BASE_URL,
      requestTimeoutMs: parseTimeoutMs(process.env.OPENAI_TIMEOUT_MS, 15_000),
      defaultPricing: pricing.defaultPricing,
      aliasPricing: pricing.aliasPricing
    });
  }

  return new MockModelClient();
}

