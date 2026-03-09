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
  buildOpenAIChatCompletionRequest,
  buildOpenAIResponsesRequest,
  withOpenAIDeadline
} from "./openai/requestBuilder";
import {
  type OpenAIChatCompletionResponse,
  type OpenAIResponsesResponse,
  extractStructuredOpenAIChatJsonPayload,
  extractStructuredOpenAIResponsesJsonPayload
} from "./openai/responseNormalization";
import {
  getAlternateOpenAITransport,
  resolveOpenAITransportSelection
} from "./openai/modelProfiles";
import type {
  OpenAINormalizedUsage,
  OpenAIRequestBuildResult,
  OpenAIStructuredOutputMode,
  OpenAITransport,
  OpenAITransportMode
} from "./openai/transportContracts";
import { normalizeStructuredModelOutput, validateStructuredModelOutput } from "./schema/validation";

interface OpenAIAttemptPlan {
  transport: OpenAITransport;
  includeTemperature: boolean;
  structuredOutputMode: OpenAIStructuredOutputMode;
}

interface OpenAIRequestErrorContext {
  status: number;
  transport: OpenAITransport;
  includedTemperature: boolean;
  structuredOutputMode: OpenAIStructuredOutputMode;
  providerMessage: string;
}

interface OpenAIRequestError extends Error {
  compatibilityContext?: OpenAIRequestErrorContext;
}

type OpenAICompatibilityFailureKind =
  | "unsupported_parameter"
  | "unsupported_transport"
  | "unsupported_schema"
  | "other";

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
   * @param usage - Normalized provider usage payload.
   * @param model - Resolved model metadata used for pricing lookup.
   */
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
    this.usage.estimatedSpendUsd = Number((this.usage.estimatedSpendUsd + estimatedSpendUsd).toFixed(8));
  }

  /**
   * Builds the primary transport attempt for one resolved model request.
   *
   * **Why it exists:**
   * Transport and parameter selection must stay capability-aware while keeping the public client
   * entrypoint stable and transport-agnostic.
   *
   * **What it talks to:**
   * - Uses `resolveOpenAITransportSelection` from `./openai/modelProfiles`.
   *
   * @param resolvedModel - Resolved provider model metadata for this request.
   * @returns Primary attempt plan for the selected model transport.
   */
  private buildPrimaryAttemptPlan(resolvedModel: ResolvedOpenAIModel): OpenAIAttemptPlan {
    const selection = resolveOpenAITransportSelection(
      resolvedModel.providerModel,
      this.transportMode,
      this.compatibilityStrict
    );

    return {
      transport: selection.transport,
      includeTemperature: selection.profile.supportsTemperature,
      structuredOutputMode: "json_schema"
    };
  }

  /**
   * Builds one transport-specific request payload for an attempt plan.
   *
   * **Why it exists:**
   * The model client dispatches between chat and responses transports, but request assembly should
   * stay owned by the transport-specific builders.
   *
   * **What it talks to:**
   * - Uses `buildOpenAIChatCompletionRequest` and `buildOpenAIResponsesRequest` from
   *   `./openai/requestBuilder`.
   *
   * @param resolvedModel - Resolved provider model metadata for this request.
   * @param request - Structured completion request routed through the model client.
   * @param attempt - Attempt plan chosen for this request.
   * @param abortSignal - Abort signal used to cancel the provider request on timeout.
   * @returns Transport-specific request build result.
   */
  private buildRequestForAttempt(
    resolvedModel: ResolvedOpenAIModel,
    request: StructuredCompletionRequest,
    attempt: OpenAIAttemptPlan,
    abortSignal: AbortSignal
  ): OpenAIRequestBuildResult {
    if (attempt.transport === "responses") {
      return buildOpenAIResponsesRequest({
        apiKey: this.options.apiKey,
        model: resolvedModel,
        request,
        abortSignal,
        includeTemperature: attempt.includeTemperature,
        structuredOutputMode: attempt.structuredOutputMode
      });
    }

    return buildOpenAIChatCompletionRequest({
      apiKey: this.options.apiKey,
      model: resolvedModel,
      request,
      abortSignal,
      includeTemperature: attempt.includeTemperature,
      structuredOutputMode: attempt.structuredOutputMode
    });
  }

  /**
   * Reads one provider error message from an arbitrary OpenAI error payload.
   *
   * **Why it exists:**
   * Compatibility fallback depends on stable error-message classification even when the transport
   * returns different JSON shapes.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param payload - Parsed JSON payload returned by the provider.
   * @returns Human-readable provider error message when present.
   */
  private readProviderErrorMessage(payload: unknown): string | null {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    const maybeError = (payload as { error?: { message?: unknown } }).error;
    return typeof maybeError?.message === "string" ? maybeError.message : null;
  }

  /**
   * Parses a provider JSON payload for one transport attempt.
   *
   * **Why it exists:**
   * OpenAI error and success flows both depend on JSON payload inspection, but fetch can still fail
   * to decode malformed bodies. This helper keeps that parse boundary explicit.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param response - Fetch response returned by the provider.
   * @returns Parsed JSON payload or `null` when decoding fails.
   */
  private async parseJsonPayload(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  /**
   * Wraps one provider failure in an error that preserves compatibility retry context.
   *
   * **Why it exists:**
   * Retry classification needs transport, parameter, and schema-mode context without changing the
   * public model-client error contract.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param context - Structured compatibility context for the failed request.
   * @returns Error instance carrying compatibility metadata.
   */
  private createRequestError(context: OpenAIRequestErrorContext): OpenAIRequestError {
    const error = new Error(
      `OpenAI ${context.transport} request failed with ${context.status}: ${context.providerMessage}`
    ) as OpenAIRequestError;
    error.compatibilityContext = context;
    return error;
  }

  /**
   * Classifies whether one provider error is a compatibility issue that allows one deterministic retry.
   *
   * **Why it exists:**
   * Retry behavior must be narrow and auditable, so the model client needs a single classifier that
   * distinguishes parameter, transport, and schema incompatibilities from ordinary failures.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param message - Provider error message captured from the failed attempt.
   * @returns Compatibility failure category for retry selection.
   */
  private classifyCompatibilityFailure(message: string): OpenAICompatibilityFailureKind {
    const unsupportedPattern =
      /(unsupported|unknown|invalid|not supported|not available|does not support|only available)/i;

    if (
      unsupportedPattern.test(message) &&
      /(response_format|text\.format|json_schema|structured output|structured response|json object|schema)/i.test(
        message
      )
    ) {
      return "unsupported_schema";
    }

    if (
      unsupportedPattern.test(message) &&
      /(chat\/completions|chat completions|responses api|responses endpoint|response endpoint|endpoint)/i.test(
        message
      )
    ) {
      return "unsupported_transport";
    }

    if (
      unsupportedPattern.test(message) &&
      /(temperature|top_p|reasoning_effort|verbosity|parameter)/i.test(message)
    ) {
      return "unsupported_parameter";
    }

    return "other";
  }

  /**
   * Builds one deterministic fallback attempt after a compatibility failure.
   *
   * **Why it exists:**
   * The runtime should recover from predictable transport and parameter mismatches without turning
   * provider retries into an unbounded probe loop.
   *
   * **What it talks to:**
   * - Uses `getAlternateOpenAITransport` and `resolveOpenAITransportSelection` from
   *   `./openai/modelProfiles`.
   * - Uses `classifyCompatibilityFailure` within this module.
   *
   * @param error - Failed request error carrying compatibility metadata.
   * @param resolvedModel - Resolved provider model metadata for this request.
   * @param priorAttempt - Primary attempt plan that failed.
   * @returns One fallback attempt plan or `null` when no deterministic retry is allowed.
   */
  private buildFallbackAttemptPlan(
    error: OpenAIRequestError,
    resolvedModel: ResolvedOpenAIModel,
    priorAttempt: OpenAIAttemptPlan
  ): OpenAIAttemptPlan | null {
    const context = error.compatibilityContext;
    if (!context) {
      return null;
    }

    const selection = resolveOpenAITransportSelection(
      resolvedModel.providerModel,
      "auto",
      false
    );
    const failureKind = this.classifyCompatibilityFailure(context.providerMessage);

    if (failureKind === "unsupported_parameter" && priorAttempt.includeTemperature) {
      return {
        ...priorAttempt,
        includeTemperature: false
      };
    }

    if (failureKind === "unsupported_transport") {
      const alternateTransport = getAlternateOpenAITransport(priorAttempt.transport);
      if (!alternateTransport) {
        return null;
      }
      if (
        this.compatibilityStrict &&
        !selection.profile.supportedTransports.includes(alternateTransport)
      ) {
        return null;
      }

      return {
        transport: alternateTransport,
        includeTemperature: selection.profile.supportsTemperature,
        structuredOutputMode: priorAttempt.structuredOutputMode
      };
    }

    if (
      failureKind === "unsupported_schema" &&
      this.allowJsonObjectCompatibilityFallback &&
      selection.profile.supportsJsonObjectStructuredOutput &&
      priorAttempt.structuredOutputMode !== "json_object"
    ) {
      return {
        ...priorAttempt,
        structuredOutputMode: "json_object"
      };
    }

    return null;
  }

  /**
   * Executes one OpenAI transport attempt and returns the validated structured JSON result.
   *
   * **Why it exists:**
   * The public client entrypoint should stay small; this helper owns transport dispatch, response
   * parsing, usage tracking, and compatibility-context error wrapping for one attempt.
   *
   * **What it talks to:**
   * - Uses transport-specific request builders from `./openai/requestBuilder`.
   * - Uses response parsers from `./openai/responseNormalization`.
   * - Uses `normalizeStructuredModelOutput` and `validateStructuredModelOutput` from
   *   `./schema/validation`.
   * - Uses `trackUsage` within this module.
   *
   * @param resolvedModel - Resolved provider model metadata for this request.
   * @param request - Structured completion request routed through the model client.
   * @param attempt - Attempt plan chosen for this request.
   * @returns Parsed and schema-validated JSON payload typed as `T`.
   */
  private async executeAttempt<T>(
    resolvedModel: ResolvedOpenAIModel,
    request: StructuredCompletionRequest,
    attempt: OpenAIAttemptPlan
  ): Promise<T> {
    const abortController = new AbortController();
    const requestBuild = this.buildRequestForAttempt(
      resolvedModel,
      request,
      attempt,
      abortController.signal
    );
    const response = await withOpenAIDeadline(
      fetch(`${this.baseUrl}${requestBuild.path}`, requestBuild.requestInit),
      this.requestTimeoutMs,
      () => abortController.abort()
    );

    const payload = await this.parseJsonPayload(response);
    if (!response.ok) {
      throw this.createRequestError({
        status: response.status,
        transport: attempt.transport,
        includedTemperature: requestBuild.includedTemperature,
        structuredOutputMode: requestBuild.structuredOutputModeUsed,
        providerMessage:
          this.readProviderErrorMessage(payload) ??
          `OpenAI request failed with ${response.status}.`
      });
    }

    const normalizedPayload =
      attempt.transport === "responses"
        ? extractStructuredOpenAIResponsesJsonPayload(payload as OpenAIResponsesResponse)
        : extractStructuredOpenAIChatJsonPayload(payload as OpenAIChatCompletionResponse);
    this.trackUsage(normalizedPayload.usage, resolvedModel);

    const parsed = JSON.parse(normalizedPayload.jsonPayload) as unknown;
    const normalized = normalizeStructuredModelOutput(request.schemaName, parsed);
    validateStructuredModelOutput(request.schemaName, normalized);
    return normalized as T;
  }

  /**
   * Executes a structured JSON completion against OpenAI and validates the result.
   *
   * **Why it exists:**
   * Provides one governed adapter boundary from internal structured prompts to provider output.
   *
   * **What it talks to:**
   * - OpenAI transport-specific endpoints via `fetch`.
   * - Timeout/abort control via `withDeadline` and `AbortController`.
   * - Schema normalization/validation via `normalizeStructuredModelOutput` and
   *   `validateStructuredModelOutput`.
   * - Usage telemetry accumulation via `trackUsage`.
   * - Compatibility retry policy via `buildFallbackAttemptPlan`.
   *
   * @param request - Structured completion request (prompts, schema name, model, temperature).
   * @returns Parsed and schema-validated JSON payload typed as `T`.
   */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    const resolvedModel = resolveOpenAIModel(request.model);
    const primaryAttempt = this.buildPrimaryAttemptPlan(resolvedModel);

    try {
      return await this.executeAttempt<T>(resolvedModel, request, primaryAttempt);
    } catch (error) {
      const fallbackAttempt = this.buildFallbackAttemptPlan(
        error as OpenAIRequestError,
        resolvedModel,
        primaryAttempt
      );
      if (!fallbackAttempt) {
        throw error;
      }
      return await this.executeAttempt<T>(resolvedModel, request, fallbackAttempt);
    }
  }
}
