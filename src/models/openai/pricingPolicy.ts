/**
 * @fileoverview Canonical OpenAI model alias and pricing helpers.
 */

import type { OpenAITokenPricing } from "./contracts";

export interface ResolvedOpenAIModel {
  requestedModel: string;
  aliasModel: string | null;
  providerModel: string;
}

export interface OpenAIPricingConfig {
  defaultPricing: OpenAITokenPricing;
  aliasPricing: Record<string, OpenAITokenPricing>;
}

const OPENAI_MODEL_ALIAS_ENV: Record<string, string> = {
  "small-fast-model": "OPENAI_MODEL_SMALL_FAST",
  "small-policy-model": "OPENAI_MODEL_SMALL_POLICY",
  "medium-general-model": "OPENAI_MODEL_MEDIUM_GENERAL",
  "medium-policy-model": "OPENAI_MODEL_MEDIUM_POLICY",
  "large-reasoning-model": "OPENAI_MODEL_LARGE_REASONING"
};

const OPENAI_MODEL_ALIAS_IDS = new Set(Object.keys(OPENAI_MODEL_ALIAS_ENV));

/**
 * Resolves a safe provider model fallback when an alias env override is missing.
 *
 * **Why it exists:**
 * Alias labels are used across the codebase; this function defines the deterministic fallback
 * provider model instead of scattering defaults.
 *
 * **What it talks to:**
 * - `OPENAI_MODEL_ALIAS_ENV` alias registry within this module.
 *
 * @param alias - Requested model alias (for example `small-fast-model`).
 * @returns Provider model id to use for that alias.
 */
export function defaultOpenAIModelForAlias(alias: string): string {
  if (Object.prototype.hasOwnProperty.call(OPENAI_MODEL_ALIAS_ENV, alias)) {
    return "gpt-4o-mini";
  }

  return alias;
}

/**
 * Resolves logical model labels into concrete provider model ids.
 *
 * **Why it exists:**
 * Planner/governor/executor code refers to stable alias names, while provider calls need
 * concrete model ids and optional env-based overrides.
 *
 * **What it talks to:**
 * - `OPENAI_MODEL_ALIAS_ENV` for alias-to-env mapping.
 * - Process environment (`OPENAI_MODEL_*`) for deployment-specific overrides.
 * - `defaultOpenAIModelForAlias` fallback policy.
 *
 * @param modelLabel - Model label selected by routing logic.
 * @returns Requested alias context plus final provider model id.
 */
export function resolveOpenAIModel(modelLabel: string): ResolvedOpenAIModel {
  const envKey = OPENAI_MODEL_ALIAS_ENV[modelLabel];
  if (!envKey) {
    return {
      requestedModel: modelLabel,
      aliasModel: null,
      providerModel: modelLabel
    };
  }

  const envModel = process.env[envKey];
  if (typeof envModel === "string" && envModel.trim().length > 0) {
    return {
      requestedModel: modelLabel,
      aliasModel: modelLabel,
      providerModel: envModel.trim()
    };
  }

  return {
    requestedModel: modelLabel,
    aliasModel: modelLabel,
    providerModel: defaultOpenAIModelForAlias(modelLabel)
  };
}

/**
 * Parses non-negative number input from environment configuration.
 *
 * **Why it exists:**
 * Keeps OpenAI pricing env parsing deterministic across bootstrap and test paths.
 *
 * **What it talks to:**
 * - Uses local numeric guards only.
 *
 * @param value - Raw environment value.
 * @param fallback - Value returned when parsing fails.
 * @returns Computed numeric value.
 */
export function parseNonNegativeNumber(value: string | undefined, fallback: number): number {
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
 * Builds pricing tables from the current environment.
 *
 * **Why it exists:**
 * Keeps alias-pricing bootstrap logic aligned between `createModelClient.ts` and OpenAI usage
 * accounting without duplicating env parsing.
 *
 * **What it talks to:**
 * - Uses `parseNonNegativeNumber` from this module.
 *
 * @param env - Process environment values used for pricing overrides.
 * @returns Canonical default and alias pricing configuration.
 */
export function buildOpenAIPricingFromEnv(env: NodeJS.ProcessEnv): OpenAIPricingConfig {
  const defaultPricing: OpenAITokenPricing = {
    inputPer1MUsd: parseNonNegativeNumber(env.OPENAI_PRICE_INPUT_PER_1M_USD, 0),
    outputPer1MUsd: parseNonNegativeNumber(env.OPENAI_PRICE_OUTPUT_PER_1M_USD, 0)
  };

  const aliasPricing: Record<string, OpenAITokenPricing> = {
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
 * Normalizes provider token metrics to non-negative integer counts.
 *
 * **Why it exists:**
 * Usage fields can be missing, fractional, or malformed; spend accounting should remain safe.
 *
 * **What it talks to:**
 * - Uses local numeric guards only.
 *
 * @param value - Raw token metric from provider payload.
 * @returns Floor-rounded token count, or `0` when invalid.
 */
export function safeTokenCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

/**
 * Estimates USD spend from prompt/completion token counts and pricing.
 *
 * **Why it exists:**
 * Runtime budget policy depends on deterministic spend estimation from provider usage data.
 *
 * **What it talks to:**
 * - Uses `OpenAITokenPricing` values configured for aliases/defaults.
 *
 * @param promptTokens - Prompt token count for the request.
 * @param completionTokens - Completion token count for the response.
 * @param pricing - Per-1M token input/output price configuration.
 * @returns Rounded spend estimate in USD.
 */
export function estimateSpendUsd(
  promptTokens: number,
  completionTokens: number,
  pricing: OpenAITokenPricing
): number {
  const inputCost = (promptTokens / 1_000_000) * pricing.inputPer1MUsd;
  const outputCost = (completionTokens / 1_000_000) * pricing.outputPer1MUsd;
  return Number((inputCost + outputCost).toFixed(8));
}

/**
 * Resolves which token-pricing table applies to a resolved model selection.
 *
 * **Why it exists:**
 * Usage accounting supports alias-specific pricing while keeping a deterministic default path.
 *
 * **What it talks to:**
 * - Alias pricing overrides supplied by bootstrap code.
 * - Default pricing fallback values.
 * - Alias model metadata from `resolveOpenAIModel`.
 *
 * @param model - Resolved provider model metadata for the request.
 * @param defaultPricing - Fallback default pricing values.
 * @param aliasPricing - Alias-specific pricing overrides keyed by logical model alias.
 * @returns Pricing record used to estimate spend for this call.
 */
export function resolveOpenAIPricing(
  model: ResolvedOpenAIModel,
  defaultPricing: OpenAITokenPricing,
  aliasPricing: Partial<Record<string, OpenAITokenPricing>>
): OpenAITokenPricing {
  if (model.aliasModel && aliasPricing[model.aliasModel]) {
    return aliasPricing[model.aliasModel] as OpenAITokenPricing;
  }

  if (OPENAI_MODEL_ALIAS_IDS.has(model.requestedModel)) {
    return defaultPricing;
  }

  return defaultPricing;
}
