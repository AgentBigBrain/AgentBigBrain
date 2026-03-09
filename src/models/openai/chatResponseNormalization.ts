/**
 * @fileoverview Normalizes OpenAI Chat Completions responses into structured JSON payloads.
 */

import type {
  OpenAINormalizedCompletionPayload,
  OpenAINormalizedUsage
} from "./transportContracts";

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
 * - Uses local string parsing only.
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
 * Converts Chat Completions usage fields into the runtime's normalized usage contract.
 *
 * **Why it exists:**
 * The model client needs one transport-agnostic usage shape so spend tracking remains stable when
 * the selected OpenAI transport changes.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param payload - Parsed Chat Completions response payload.
 * @returns Normalized usage counters for this provider response.
 */
export function normalizeOpenAIChatUsage(
  payload: OpenAIChatCompletionResponse
): OpenAINormalizedUsage {
  return {
    promptTokens: Math.max(0, Math.floor(payload.usage?.prompt_tokens ?? 0)),
    completionTokens: Math.max(0, Math.floor(payload.usage?.completion_tokens ?? 0)),
    totalTokens: Math.max(0, Math.floor(payload.usage?.total_tokens ?? 0))
  };
}

/**
 * Extracts structured JSON payload text from one Chat Completions response.
 *
 * **Why it exists:**
 * Keeps Chat Completions content validation and wrapped-JSON extraction in one place so the model
 * client only coordinates transport dispatch, retries, and schema validation.
 *
 * **What it talks to:**
 * - Uses `extractJsonPayload` and `normalizeOpenAIChatUsage` from this module.
 *
 * @param payload - Parsed Chat Completions response payload.
 * @returns JSON payload string plus normalized usage counters.
 */
export function extractStructuredOpenAIChatJsonPayload(
  payload: OpenAIChatCompletionResponse
): OpenAINormalizedCompletionPayload {
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI chat completion response was missing message content.");
  }

  return {
    jsonPayload: extractJsonPayload(content),
    usage: normalizeOpenAIChatUsage(payload)
  };
}
