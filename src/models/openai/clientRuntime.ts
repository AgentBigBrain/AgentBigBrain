/**
 * @fileoverview Shared OpenAI attempt planning, compatibility fallback, and response execution.
 */

import type { StructuredCompletionRequest } from "../types";
import { normalizeStructuredModelOutput, validateStructuredModelOutput } from "../schema/validation";
import type { OpenAIChatCompletionResponse, OpenAIResponsesResponse } from "./responseNormalization";
import {
  extractStructuredOpenAIChatJsonPayload,
  extractStructuredOpenAIResponsesJsonPayload
} from "./responseNormalization";
import type { ResolvedOpenAIModel } from "./pricingPolicy";
import { getAlternateOpenAITransport, resolveOpenAITransportSelection } from "./modelProfiles";
import {
  buildOpenAIChatCompletionRequest,
  buildOpenAIResponsesRequest,
  type OpenAIModelClientOptions,
  withOpenAIDeadline
} from "./requestBuilder";
import type {
  OpenAINormalizedUsage,
  OpenAIRequestBuildResult,
  OpenAIStructuredOutputMode,
  OpenAITransport
} from "./transportContracts";

export interface OpenAIClientRuntimeSettings
  extends Required<
    Pick<
      OpenAIModelClientOptions,
      | "apiKey"
      | "transportMode"
      | "compatibilityStrict"
      | "allowJsonObjectCompatibilityFallback"
    >
  > {
  baseUrl: string;
  requestTimeoutMs: number;
}

export interface OpenAIAttemptPlan {
  transport: OpenAITransport;
  includeTemperature: boolean;
  structuredOutputMode: OpenAIStructuredOutputMode;
}

interface OpenAIRequestErrorContext {
  status: number;
  transport: OpenAITransport;
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

/**
 * Builds the preferred transport attempt for one resolved model request.
 *
 * @param providerModel - Concrete provider model name after alias resolution.
 * @param transportMode - Operator-selected transport override mode.
 * @param compatibilityStrict - Whether unsupported transports should fail closed.
 * @returns Primary attempt plan for the resolved model family.
 */
export function buildPrimaryOpenAIAttemptPlan(
  providerModel: string,
  transportMode: OpenAIClientRuntimeSettings["transportMode"],
  compatibilityStrict: boolean
): OpenAIAttemptPlan {
  const selection = resolveOpenAITransportSelection(
    providerModel,
    transportMode,
    compatibilityStrict
  );

  return {
    transport: selection.transport,
    includeTemperature: selection.profile.supportsTemperature,
    structuredOutputMode: "json_schema"
  };
}

/**
 * Executes a structured OpenAI request with one bounded compatibility retry.
 *
 * @param settings - Stable runtime settings for OpenAI transport execution.
 * @param resolvedModel - Resolved provider model metadata for this request.
 * @param request - Structured request being sent to the provider.
 * @param trackUsage - Callback used to aggregate normalized provider usage.
 * @returns Parsed and validated structured output typed as `T`.
 */
export async function completeOpenAIJsonRequest<T>(
  settings: OpenAIClientRuntimeSettings,
  resolvedModel: ResolvedOpenAIModel,
  request: StructuredCompletionRequest,
  trackUsage: (usage: OpenAINormalizedUsage, model: ResolvedOpenAIModel) => void
): Promise<T> {
  const primaryAttempt = buildPrimaryOpenAIAttemptPlan(
    resolvedModel.providerModel,
    settings.transportMode,
    settings.compatibilityStrict
  );

  try {
    return await executeOpenAIAttempt(settings, resolvedModel, request, primaryAttempt, trackUsage);
  } catch (error) {
    const fallbackAttempt = buildFallbackOpenAIAttemptPlan(
      error as OpenAIRequestError,
      settings,
      resolvedModel,
      primaryAttempt
    );
    if (!fallbackAttempt) {
      throw error;
    }
    return await executeOpenAIAttempt(settings, resolvedModel, request, fallbackAttempt, trackUsage);
  }
}

/**
 * Builds the transport-specific provider request payload for one attempt plan.
 *
 * @param settings - Stable runtime settings for OpenAI transport execution.
 * @param resolvedModel - Resolved provider model metadata for this request.
 * @param request - Structured request being sent to the provider.
 * @param attempt - Attempt plan currently being executed.
 * @param abortSignal - Abort signal used to cancel the outbound provider request.
 * @returns Transport-specific request build result.
 */
function buildRequestForAttempt(
  settings: OpenAIClientRuntimeSettings,
  resolvedModel: ResolvedOpenAIModel,
  request: StructuredCompletionRequest,
  attempt: OpenAIAttemptPlan,
  abortSignal: AbortSignal
): OpenAIRequestBuildResult {
  if (attempt.transport === "responses") {
    return buildOpenAIResponsesRequest({
      apiKey: settings.apiKey,
      model: resolvedModel,
      request,
      abortSignal,
      includeTemperature: attempt.includeTemperature,
      structuredOutputMode: attempt.structuredOutputMode
    });
  }

  return buildOpenAIChatCompletionRequest({
    apiKey: settings.apiKey,
    model: resolvedModel,
    request,
    abortSignal,
    includeTemperature: attempt.includeTemperature,
    structuredOutputMode: attempt.structuredOutputMode
  });
}

/**
 * Executes one OpenAI transport attempt and validates the structured JSON result.
 *
 * @param settings - Stable runtime settings for OpenAI transport execution.
 * @param resolvedModel - Resolved provider model metadata for this request.
 * @param request - Structured request being sent to the provider.
 * @param attempt - Attempt plan currently being executed.
 * @param trackUsage - Callback used to aggregate normalized provider usage.
 * @returns Parsed and validated structured output typed as `T`.
 */
async function executeOpenAIAttempt<T>(
  settings: OpenAIClientRuntimeSettings,
  resolvedModel: ResolvedOpenAIModel,
  request: StructuredCompletionRequest,
  attempt: OpenAIAttemptPlan,
  trackUsage: (usage: OpenAINormalizedUsage, model: ResolvedOpenAIModel) => void
): Promise<T> {
  const abortController = new AbortController();
  const requestBuild = buildRequestForAttempt(
    settings,
    resolvedModel,
    request,
    attempt,
    abortController.signal
  );
  const response = await withOpenAIDeadline(
    fetch(`${settings.baseUrl}${requestBuild.path}`, requestBuild.requestInit),
    settings.requestTimeoutMs,
    () => abortController.abort()
  );

  const payload = await parseJsonPayload(response);
  if (!response.ok) {
    throw createOpenAIRequestError({
      status: response.status,
      transport: attempt.transport,
      providerMessage:
        readOpenAIProviderErrorMessage(payload) ?? `OpenAI request failed with ${response.status}.`
    });
  }

  const normalizedPayload =
    attempt.transport === "responses"
      ? extractStructuredOpenAIResponsesJsonPayload(payload as OpenAIResponsesResponse)
      : extractStructuredOpenAIChatJsonPayload(payload as OpenAIChatCompletionResponse);
  trackUsage(normalizedPayload.usage, resolvedModel);

  const parsed = JSON.parse(normalizedPayload.jsonPayload) as unknown;
  const normalized = normalizeStructuredModelOutput(request.schemaName, parsed);
  validateStructuredModelOutput(request.schemaName, normalized);
  return normalized as T;
}

/**
 * Builds one bounded compatibility fallback attempt after a provider mismatch failure.
 *
 * @param error - Failed request error carrying compatibility metadata.
 * @param settings - Stable runtime settings for OpenAI transport execution.
 * @param resolvedModel - Resolved provider model metadata for this request.
 * @param priorAttempt - Attempt plan that just failed.
 * @returns One deterministic fallback attempt or `null` when no retry is allowed.
 */
function buildFallbackOpenAIAttemptPlan(
  error: OpenAIRequestError,
  settings: OpenAIClientRuntimeSettings,
  resolvedModel: ResolvedOpenAIModel,
  priorAttempt: OpenAIAttemptPlan
): OpenAIAttemptPlan | null {
  const context = error.compatibilityContext;
  if (!context) {
    return null;
  }

  const selection = resolveOpenAITransportSelection(resolvedModel.providerModel, "auto", false);
  const failureKind = classifyOpenAICompatibilityFailure(context.providerMessage);

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
      settings.compatibilityStrict &&
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
    settings.allowJsonObjectCompatibilityFallback &&
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
 * Classifies whether a provider error message reflects a compatibility mismatch.
 *
 * @param message - Provider error message captured from a failed attempt.
 * @returns Compatibility failure category for retry selection.
 */
function classifyOpenAICompatibilityFailure(message: string): OpenAICompatibilityFailureKind {
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
 * Wraps one provider failure in an error that preserves compatibility retry context.
 *
 * @param context - Structured compatibility context for the failed request.
 * @returns Error instance carrying compatibility metadata.
 */
function createOpenAIRequestError(context: OpenAIRequestErrorContext): OpenAIRequestError {
  const error = new Error(
    `OpenAI ${context.transport} request failed with ${context.status}: ${context.providerMessage}`
  ) as OpenAIRequestError;
  error.compatibilityContext = context;
  return error;
}

/**
 * Parses a provider JSON payload while failing closed on malformed response bodies.
 *
 * @param response - Fetch response returned by the provider.
 * @returns Parsed JSON payload or `null` when decoding fails.
 */
async function parseJsonPayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Reads the provider error message from an arbitrary OpenAI error payload.
 *
 * @param payload - Parsed JSON payload returned by the provider.
 * @returns Human-readable provider error message when present.
 */
function readOpenAIProviderErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const maybeError = (payload as { error?: { message?: unknown } }).error;
  return typeof maybeError?.message === "string" ? maybeError.message : null;
}
