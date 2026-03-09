/**
 * @fileoverview Normalizes OpenAI Responses API payloads into structured JSON payloads.
 */

import { extractJsonPayload } from "./chatResponseNormalization";
import type {
  OpenAINormalizedCompletionPayload,
  OpenAINormalizedUsage
} from "./transportContracts";

interface OpenAIResponsesContentItem {
  type?: string;
  text?: string | {
    value?: string;
  };
}

interface OpenAIResponsesOutputItem {
  content?: OpenAIResponsesContentItem[];
}

export interface OpenAIResponsesResponse {
  output_text?: string;
  output?: OpenAIResponsesOutputItem[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
  };
}

/**
 * Reads one content item and extracts text when the shape represents model-emitted text.
 *
 * **Why it exists:**
 * Responses API payloads can expose text content through multiple object shapes; this helper keeps
 * that extraction logic centralized and intentionally conservative.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param item - One content item from a Responses API output entry.
 * @returns Extracted text when present, otherwise `null`.
 */
function extractResponsesContentText(item: OpenAIResponsesContentItem): string | null {
  if (!item || typeof item !== "object") {
    return null;
  }
  if (typeof item.text === "string") {
    return item.text;
  }
  if (item.text && typeof item.text === "object" && typeof item.text.value === "string") {
    return item.text.value;
  }
  return null;
}

/**
 * Converts Responses API usage fields into the runtime's normalized usage contract.
 *
 * **Why it exists:**
 * The model client needs one transport-agnostic usage shape so spend tracking remains stable when
 * the selected OpenAI transport changes.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param payload - Parsed Responses API payload.
 * @returns Normalized usage counters for this provider response.
 */
export function normalizeOpenAIResponsesUsage(
  payload: OpenAIResponsesResponse
): OpenAINormalizedUsage {
  return {
    promptTokens: Math.max(0, Math.floor(payload.usage?.input_tokens ?? 0)),
    completionTokens: Math.max(0, Math.floor(payload.usage?.output_tokens ?? 0)),
    totalTokens: Math.max(0, Math.floor(payload.usage?.total_tokens ?? 0))
  };
}

/**
 * Extracts the best available text payload from one Responses API response.
 *
 * **Why it exists:**
 * The Responses API can expose text through a convenience `output_text` field or through nested
 * output items. This helper keeps those transport-specific extraction details out of the model
 * client.
 *
 * **What it talks to:**
 * - Uses `extractResponsesContentText` within this module.
 *
 * @param payload - Parsed Responses API payload.
 * @returns Raw generated text to feed into JSON extraction.
 */
function extractResponsesOutputText(payload: OpenAIResponsesResponse): string {
  if (typeof payload.output_text === "string" && payload.output_text.trim().length > 0) {
    return payload.output_text;
  }

  const fragments: string[] = [];
  for (const outputItem of payload.output ?? []) {
    for (const contentItem of outputItem.content ?? []) {
      const text = extractResponsesContentText(contentItem);
      if (text && text.trim().length > 0) {
        fragments.push(text);
      }
    }
  }

  const combined = fragments.join("\n").trim();
  if (combined.length > 0) {
    return combined;
  }

  throw new Error("OpenAI responses payload was missing output text.");
}

/**
 * Extracts structured JSON payload text from one Responses API payload.
 *
 * **Why it exists:**
 * Keeps Responses-specific text extraction and usage normalization in one place so the model
 * client only coordinates transport dispatch, retries, and schema validation.
 *
 * **What it talks to:**
 * - Uses `extractJsonPayload` from `./chatResponseNormalization`.
 * - Uses `normalizeOpenAIResponsesUsage` within this module.
 *
 * @param payload - Parsed Responses API payload.
 * @returns JSON payload string plus normalized usage counters.
 */
export function extractStructuredOpenAIResponsesJsonPayload(
  payload: OpenAIResponsesResponse
): OpenAINormalizedCompletionPayload {
  return {
    jsonPayload: extractJsonPayload(extractResponsesOutputText(payload)),
    usage: normalizeOpenAIResponsesUsage(payload)
  };
}
