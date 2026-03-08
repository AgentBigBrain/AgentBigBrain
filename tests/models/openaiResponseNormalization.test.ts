/**
 * @fileoverview Tests canonical OpenAI response-normalization helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  extractJsonPayload,
  extractStructuredOpenAIJsonPayload
} from "../../src/models/openai/responseNormalization";

test("extractJsonPayload unwraps JSON embedded in surrounding text", () => {
  const payload = extractJsonPayload("Here is your payload:\n{\"plannerNotes\":\"wrapped\"}\nDone.");
  assert.equal(payload, "{\"plannerNotes\":\"wrapped\"}");
});

test("extractStructuredOpenAIJsonPayload rejects missing content", () => {
  assert.throws(
    () =>
      extractStructuredOpenAIJsonPayload({
        choices: [{ message: {} }]
      }),
    /missing message content/i
  );
});
