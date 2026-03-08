/**
 * @fileoverview Canonical OpenAI request-building and deadline helpers.
 */

import { buildOpenAIResponseFormatContract } from "./schemaEnvelope";
import type { ResolvedOpenAIModel } from "./pricingPolicy";
import type { OpenAITokenPricing } from "./contracts";
import type { StructuredCompletionRequest } from "../types";

export interface OpenAIModelClientOptions {
  apiKey: string;
  baseUrl?: string;
  requestTimeoutMs?: number;
  defaultPricing?: OpenAITokenPricing;
  aliasPricing?: Partial<Record<string, OpenAITokenPricing>>;
}

/**
 * Builds the OpenAI chat-completions request payload for a structured model request.
 *
 * **Why it exists:**
 * Keeps provider request assembly canonical inside the OpenAI runtime subsystem instead of
 * rebuilding headers and message structure inside the stable entrypoint.
 *
 * **What it talks to:**
 * - Uses `buildOpenAIResponseFormatContract` from `./schemaEnvelope`.
 * - Uses `ResolvedOpenAIModel` from `./pricingPolicy`.
 * - Uses `StructuredCompletionRequest` from `../types`.
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
  return {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: model.providerModel,
      temperature: request.temperature ?? 0,
      response_format: buildOpenAIResponseFormatContract(request.schemaName),
      messages: [
        {
          role: "system",
          content: `${request.systemPrompt}\nReturn only valid JSON for schema ${request.schemaName}.`
        },
        {
          role: "user",
          content: request.userPrompt
        }
      ]
    }),
    signal: abortSignal
  };
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
