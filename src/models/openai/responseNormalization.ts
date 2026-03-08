/**
 * @fileoverview Canonical OpenAI response parsing and JSON normalization helpers.
 */

export interface OpenAIChatCompletionChoice {
  message?: {
    content?: string;
  };
}

export interface OpenAIChatCompletionResponse {
  choices?: OpenAIChatCompletionChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
  };
}

/**
 * Extracts the first JSON object from model text content.
 *
 * **Why it exists:**
 * Some providers wrap JSON with extra text; this isolates the defensive extraction logic before
 * schema validation.
 *
 * **What it talks to:**
 * - Local string parsing only.
 *
 * @param content - Raw assistant message content from provider response.
 * @returns JSON object string ready for `JSON.parse`.
 */
export function extractJsonPayload(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return trimmed.slice(first, last + 1);
  }

  throw new Error("Model response did not contain a JSON object.");
}

/**
 * Extracts structured JSON payload text from a provider response.
 *
 * **Why it exists:**
 * Keeps provider content validation and wrapped-JSON extraction in one canonical place so the
 * stable entrypoint only coordinates fetch, usage tracking, and schema validation.
 *
 * **What it talks to:**
 * - Uses `OpenAIChatCompletionResponse` from this module.
 * - Uses `extractJsonPayload` from this module.
 *
 * @param payload - Parsed OpenAI chat completion response payload.
 * @returns JSON object string ready for `JSON.parse`.
 */
export function extractStructuredOpenAIJsonPayload(
  payload: OpenAIChatCompletionResponse
): string {
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI response was missing message content.");
  }

  return extractJsonPayload(content);
}
