/**
 * @fileoverview Tests canonical OpenAI request-builder helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildOpenAIChatCompletionRequestInit } from "../../src/models/openai/requestBuilder";

test("buildOpenAIChatCompletionRequestInit emits strict response_format payload", () => {
  const abortController = new AbortController();
  const requestInit = buildOpenAIChatCompletionRequestInit(
    "test-key",
    {
      requestedModel: "large-reasoning-model",
      aliasModel: "large-reasoning-model",
      providerModel: "gpt-4.1-mini"
    },
    {
      model: "large-reasoning-model",
      schemaName: "planner_v1",
      systemPrompt: "Return planner JSON.",
      userPrompt: "Plan a safe next step.",
      temperature: 0
    },
    abortController.signal
  );

  const body = JSON.parse(String(requestInit.body)) as {
    model?: string;
    response_format?: { type?: string; json_schema?: { name?: string; strict?: boolean } };
    messages?: Array<{ role?: string; content?: string }>;
  };

  assert.equal(requestInit.method, "POST");
  assert.equal(body.model, "gpt-4.1-mini");
  assert.equal(body.response_format?.type, "json_schema");
  assert.equal(body.response_format?.json_schema?.name, "planner_v1");
  assert.equal(body.response_format?.json_schema?.strict, true);
  assert.equal(body.messages?.[0]?.role, "system");
  assert.equal(body.messages?.[1]?.role, "user");
});
