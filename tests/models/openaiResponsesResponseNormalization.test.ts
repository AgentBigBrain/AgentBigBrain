/**
 * @fileoverview Tests Responses API response-normalization helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  extractStructuredOpenAIResponsesJsonPayload
} from "../../src/models/openai/responseNormalization";

test("extractStructuredOpenAIResponsesJsonPayload reads direct output_text", () => {
  const normalized = extractStructuredOpenAIResponsesJsonPayload({
    output_text: "{\"plannerNotes\":\"ok\",\"actions\":[]}",
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      total_tokens: 14
    }
  });

  assert.equal(normalized.jsonPayload, "{\"plannerNotes\":\"ok\",\"actions\":[]}");
  assert.deepEqual(normalized.usage, {
    promptTokens: 10,
    completionTokens: 4,
    totalTokens: 14
  });
});

test("extractStructuredOpenAIResponsesJsonPayload reads nested output content when output_text is absent", () => {
  const normalized = extractStructuredOpenAIResponsesJsonPayload({
    output: [
      {
        content: [
          {
            type: "output_text",
            text: "{\"plannerNotes\":\"nested\",\"actions\":[]}"
          }
        ]
      }
    ]
  });

  assert.equal(normalized.jsonPayload, "{\"plannerNotes\":\"nested\",\"actions\":[]}");
});
