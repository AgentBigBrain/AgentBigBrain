/**
 * @fileoverview Canonical OpenAI response-normalization exports for chat and responses transports.
 */

export {
  extractJsonPayload,
  type OpenAIChatCompletionChoice,
  type OpenAIChatCompletionResponse,
  extractStructuredOpenAIChatJsonPayload,
  normalizeOpenAIChatUsage
} from "./chatResponseNormalization";
export {
  type OpenAIResponsesResponse,
  extractStructuredOpenAIResponsesJsonPayload,
  normalizeOpenAIResponsesUsage
} from "./responsesResponseNormalization";
import { extractStructuredOpenAIChatJsonPayload } from "./chatResponseNormalization";
import type { OpenAIChatCompletionResponse } from "./chatResponseNormalization";

/**
 * Extracts structured JSON payload text from a Chat Completions response using the legacy helper contract.
 *
 * **Why it exists:**
 * Existing tests and call sites still import the older helper name. This wrapper preserves that
 * stable surface while the runtime now also supports Responses payload normalization.
 *
 * **What it talks to:**
 * - Uses `extractStructuredOpenAIChatJsonPayload` from `./chatResponseNormalization`.
 *
 * @param payload - Parsed OpenAI chat completion response payload.
 * @returns JSON object string ready for `JSON.parse`.
 */
export function extractStructuredOpenAIJsonPayload(
  payload: OpenAIChatCompletionResponse
): string {
  return extractStructuredOpenAIChatJsonPayload(payload).jsonPayload;
}
