/**
 * @fileoverview Canonical OpenAI request-building exports and deadline helpers.
 */

import { buildOpenAIChatCompletionRequest } from "./chatRequestBuilder";
import { buildOpenAIResponsesRequest } from "./responsesRequestBuilder";
import type { OpenAITokenPricing } from "./contracts";
import type { ResolvedOpenAIModel } from "./pricingPolicy";
import type { OpenAITransportMode } from "./transportContracts";
import type { StructuredCompletionRequest } from "../types";

export interface OpenAIModelClientOptions {
  apiKey: string;
  baseUrl?: string;
  requestTimeoutMs?: number;
  defaultPricing?: OpenAITokenPricing;
  aliasPricing?: Partial<Record<string, OpenAITokenPricing>>;
  transportMode?: OpenAITransportMode;
  compatibilityStrict?: boolean;
  allowJsonObjectCompatibilityFallback?: boolean;
}

export { buildOpenAIChatCompletionRequest };
export { buildOpenAIResponsesRequest };

/**
 * Builds the legacy Chat Completions `RequestInit` payload for a structured model request.
 *
 * **Why it exists:**
 * Existing tests and call sites still import the older request-builder helper name. This wrapper
 * preserves that stable surface while the runtime moves to transport-specific builders underneath.
 *
 * **What it talks to:**
 * - Uses `buildOpenAIChatCompletionRequest` from `./chatRequestBuilder`.
 *
 * @param apiKey - OpenAI API key used for Authorization.
 * @param model - Resolved provider model metadata for this request.
 * @param request - Structured completion request routed through the model client.
 * @param abortSignal - Abort signal used to cancel the provider request on timeout.
 * @returns Provider-ready `RequestInit` payload for `fetch`.
 */
export function buildOpenAIChatCompletionRequestInit(
  apiKey: string,
  model: ResolvedOpenAIModel,
  request: StructuredCompletionRequest,
  abortSignal: AbortSignal
): RequestInit {
  return buildOpenAIChatCompletionRequest({
    apiKey,
    model,
    request,
    abortSignal,
    includeTemperature: true,
    structuredOutputMode: "json_schema"
  }).requestInit;
}

/**
 * Wraps an async operation with a hard timeout and caller-provided timeout side effect.
 *
 * **Why it exists:**
 * Provider requests must fail deterministically under deadline pressure.
 *
 * **What it talks to:**
 * - Node.js timer primitives.
 * - Caller timeout callback (used to abort fetch requests).
 *
 * @param promise - Underlying async operation to race against the timeout.
 * @param timeoutMs - Deadline in milliseconds.
 * @param onTimeout - Callback invoked just before timeout rejection.
 * @returns Original promise result when completed before the deadline.
 */
export async function withOpenAIDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = setTimeout(() => {
      try {
        onTimeout();
      } finally {
        reject(new Error(`OpenAI request timed out after ${timeoutMs}ms.`));
      }
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(handle);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(handle);
        reject(error);
      });
  });
}
