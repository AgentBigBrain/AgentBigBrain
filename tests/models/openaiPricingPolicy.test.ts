/**
 * @fileoverview Tests canonical OpenAI pricing-policy helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildOpenAIPricingFromEnv,
  defaultOpenAIModelForAlias,
  estimateSpendUsd,
  resolveOpenAIModel,
  resolveOpenAIPricing
} from "../../src/models/openai/pricingPolicy";

test("buildOpenAIPricingFromEnv falls back to default pricing when alias env values are missing", () => {
  const pricing = buildOpenAIPricingFromEnv({
    OPENAI_PRICE_INPUT_PER_1M_USD: "1",
    OPENAI_PRICE_OUTPUT_PER_1M_USD: "2"
  });

  assert.deepEqual(pricing.defaultPricing, {
    inputPer1MUsd: 1,
    outputPer1MUsd: 2
  });
  assert.deepEqual(pricing.aliasPricing["large-reasoning-model"], {
    inputPer1MUsd: 1,
    outputPer1MUsd: 2
  });
});

test("resolveOpenAIPricing prefers alias-specific pricing when present", () => {
  const resolvedModel = {
    requestedModel: "large-reasoning-model",
    aliasModel: "large-reasoning-model",
    providerModel: "gpt-4.1-mini"
  };

  const pricing = resolveOpenAIPricing(
    resolvedModel,
    { inputPer1MUsd: 0, outputPer1MUsd: 0 },
    {
      "large-reasoning-model": {
        inputPer1MUsd: 3,
        outputPer1MUsd: 9
      }
    }
  );

  assert.deepEqual(pricing, {
    inputPer1MUsd: 3,
    outputPer1MUsd: 9
  });
  assert.equal(estimateSpendUsd(2_000, 1_000, pricing), 0.015);
});

test("resolveOpenAIModel keeps direct provider ids unchanged", () => {
  const resolvedModel = resolveOpenAIModel("gpt-4.1-mini");

  assert.deepEqual(resolvedModel, {
    requestedModel: "gpt-4.1-mini",
    aliasModel: null,
    providerModel: "gpt-4.1-mini"
  });
});

test("defaultOpenAIModelForAlias uses role-specific fallback models", () => {
  assert.equal(defaultOpenAIModelForAlias("small-fast-model"), "gpt-4.1-mini");
  assert.equal(defaultOpenAIModelForAlias("small-policy-model"), "gpt-4.1-mini");
  assert.equal(defaultOpenAIModelForAlias("large-reasoning-model"), "gpt-4.1");
});
