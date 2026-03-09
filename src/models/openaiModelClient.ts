/**
 * @fileoverview OpenAI-backed model client for structured JSON completions with provider-usage spend tracking.
 */

import { ModelClient, ModelUsageSnapshot, StructuredCompletionRequest } from "./types";
import type { OpenAITokenPricing } from "./openai/contracts";
import { completeOpenAIJsonRequest } from "./openai/clientRuntime";
import type { OpenAIModelClientOptions } from "./openai/requestBuilder";
import type { OpenAINormalizedUsage, OpenAITransportMode } from "./openai/transportContracts";
import {
  estimateSpendUsd,
  type ResolvedOpenAIModel,
  resolveOpenAIModel,
  resolveOpenAIPricing,
  safeTokenCount
} from "./openai/pricingPolicy";

export class OpenAIModelClient implements ModelClient {
  readonly backend = "openai" as const;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly defaultPricing: OpenAITokenPricing;
  private readonly aliasPricing: Partial<Record<string, OpenAITokenPricing>>;
  private readonly transportMode: OpenAITransportMode;
  private readonly compatibilityStrict: boolean;
  private readonly allowJsonObjectCompatibilityFallback: boolean;
  private usage: ModelUsageSnapshot = {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedSpendUsd: 0
  };

  constructor(private readonly options: OpenAIModelClientOptions) {
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? 120_000);
    this.defaultPricing = options.defaultPricing ?? {
      inputPer1MUsd: 0,
      outputPer1MUsd: 0
    };
    this.aliasPricing = options.aliasPricing ?? {};
    this.transportMode = options.transportMode ?? "auto";
    this.compatibilityStrict = options.compatibilityStrict ?? false;
    this.allowJsonObjectCompatibilityFallback =
      options.allowJsonObjectCompatibilityFallback ?? false;
  }

  getUsageSnapshot(): ModelUsageSnapshot {
    return { ...this.usage };
  }

  private trackUsage(usage: OpenAINormalizedUsage, model: ResolvedOpenAIModel): void {
    const promptTokens = safeTokenCount(usage.promptTokens);
    const completionTokens = safeTokenCount(usage.completionTokens);
    const totalTokens = safeTokenCount(usage.totalTokens) || promptTokens + completionTokens;
    const pricing = resolveOpenAIPricing(model, this.defaultPricing, this.aliasPricing);
    const estimatedSpendUsd = estimateSpendUsd(promptTokens, completionTokens, pricing);

    this.usage.calls += 1;
    this.usage.promptTokens += promptTokens;
    this.usage.completionTokens += completionTokens;
    this.usage.totalTokens += totalTokens;
    this.usage.estimatedSpendUsd = Number(
      (this.usage.estimatedSpendUsd + estimatedSpendUsd).toFixed(8)
    );
  }

  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    const resolvedModel = resolveOpenAIModel(request.model);
    return await completeOpenAIJsonRequest(
      {
        apiKey: this.options.apiKey,
        baseUrl: this.baseUrl,
        requestTimeoutMs: this.requestTimeoutMs,
        transportMode: this.transportMode,
        compatibilityStrict: this.compatibilityStrict,
        allowJsonObjectCompatibilityFallback: this.allowJsonObjectCompatibilityFallback
      },
      resolvedModel,
      request,
      (usage, model) => this.trackUsage(usage, model)
    );
  }
}
