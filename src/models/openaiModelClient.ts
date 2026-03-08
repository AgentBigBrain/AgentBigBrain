/**
 * @fileoverview OpenAI-backed model client for structured JSON completions with provider-usage spend tracking.
 */

import { ModelClient, ModelUsageSnapshot, StructuredCompletionRequest } from "./types";
import {
  estimateSpendUsd,
  type ResolvedOpenAIModel,
  resolveOpenAIModel,
  resolveOpenAIPricing,
  safeTokenCount
} from "./openai/pricingPolicy";
import type { OpenAITokenPricing } from "./openai/contracts";
import {
  type OpenAIModelClientOptions,
  buildOpenAIChatCompletionRequestInit,
  withOpenAIDeadline
} from "./openai/requestBuilder";
import {
  type OpenAIChatCompletionResponse,
  extractStructuredOpenAIJsonPayload
} from "./openai/responseNormalization";
import { normalizeStructuredModelOutput, validateStructuredModelOutput } from "./schema/validation";

export class OpenAIModelClient implements ModelClient {
  readonly backend = "openai" as const;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly defaultPricing: OpenAITokenPricing;
  private readonly aliasPricing: Partial<Record<string, OpenAITokenPricing>>;
  private usage: ModelUsageSnapshot = {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedSpendUsd: 0
  };

  /**
   * Configures provider endpoint, timeout policy, and pricing tables for usage tracking.
   *
   * **Why it exists:**
   * All OpenAI request behavior should be defined once at client construction time.
   *
   * **What it talks to:**
   * - Constructor options passed by model-client bootstrap code.
   *
   * @param options - API key plus optional endpoint/timeout/pricing overrides.
   */
  constructor(private readonly options: OpenAIModelClientOptions) {
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? 15_000);
    this.defaultPricing = options.defaultPricing ?? {
      inputPer1MUsd: 0,
      outputPer1MUsd: 0
    };
    this.aliasPricing = options.aliasPricing ?? {};
  }

  /**
   * Returns a copy of aggregated provider-usage telemetry for this client instance.
   *
   * **Why it exists:**
   * Orchestrator/task-runner budget checks need read-only usage snapshots between task phases.
   *
   * **What it talks to:**
   * - Local `usage` accumulator state.
   *
   * @returns Copy of current model-usage counters and estimated spend.
   */
  getUsageSnapshot(): ModelUsageSnapshot {
    return { ...this.usage };
  }

  /**
   * Updates cumulative usage and spend metrics from a provider response.
   *
   * **Why it exists:**
   * Centralized accounting keeps budget enforcement and trace reporting consistent.
   *
   * **What it talks to:**
   * - Provider `usage` payload fields.
   * - `resolveOpenAIPricing` and `estimateSpendUsd`.
   * - Local `usage` accumulator state.
   *
   * @param payload - Parsed OpenAI chat completion response payload.
   * @param model - Resolved model metadata used for pricing lookup.
   */
  private trackUsage(payload: OpenAIChatCompletionResponse, model: ResolvedOpenAIModel): void {
    const promptTokens = safeTokenCount(payload.usage?.prompt_tokens);
    const completionTokens = safeTokenCount(payload.usage?.completion_tokens);
    const totalTokens = safeTokenCount(payload.usage?.total_tokens) || promptTokens + completionTokens;
    const pricing = resolveOpenAIPricing(model, this.defaultPricing, this.aliasPricing);
    const estimatedSpendUsd = estimateSpendUsd(promptTokens, completionTokens, pricing);

    this.usage.calls += 1;
    this.usage.promptTokens += promptTokens;
    this.usage.completionTokens += completionTokens;
    this.usage.totalTokens += totalTokens;
    this.usage.estimatedSpendUsd = Number((this.usage.estimatedSpendUsd + estimatedSpendUsd).toFixed(8));
  }

  /**
   * Executes a structured JSON completion against OpenAI and validates the result.
   *
   * **Why it exists:**
   * Provides one governed adapter boundary from internal structured prompts to provider output.
   *
   * **What it talks to:**
   * - OpenAI `chat/completions` endpoint via `fetch`.
   * - Timeout/abort control via `withDeadline` and `AbortController`.
   * - Schema normalization/validation via `normalizeStructuredModelOutput` and
   *   `validateStructuredModelOutput`.
   * - Usage telemetry accumulation via `trackUsage`.
   *
   * @param request - Structured completion request (prompts, schema name, model, temperature).
   * @returns Parsed and schema-validated JSON payload typed as `T`.
   */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    const abortController = new AbortController();
    const resolvedModel = resolveOpenAIModel(request.model);
    const response = await withOpenAIDeadline(
      fetch(
        `${this.baseUrl}/chat/completions`,
        buildOpenAIChatCompletionRequestInit(
          this.options.apiKey,
          resolvedModel,
          request,
          abortController.signal
        )
      ),
      this.requestTimeoutMs,
      () => abortController.abort()
    );

    const payload = (await response.json()) as OpenAIChatCompletionResponse;
    if (!response.ok) {
      throw new Error(payload.error?.message ?? `OpenAI request failed with ${response.status}.`);
    }

    this.trackUsage(payload, resolvedModel);
    const jsonPayload = extractStructuredOpenAIJsonPayload(payload);
    const parsed = JSON.parse(jsonPayload) as unknown;
    const normalized = normalizeStructuredModelOutput(request.schemaName, parsed);
    validateStructuredModelOutput(request.schemaName, normalized);
    return normalized as T;
  }
}
