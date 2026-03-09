/**
 * @fileoverview Tests Responses API request-builder helpers for structured OpenAI calls.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildOpenAIResponsesRequest } from "../../src/models/openai/requestBuilder";

test("buildOpenAIResponsesRequest emits input plus text.format payload", () => {
  const abortController = new AbortController();
  const requestBuild = buildOpenAIResponsesRequest({
    apiKey: "test-key",
    model: {
      requestedModel: "large-reasoning-model",
      aliasModel: "large-reasoning-model",
      providerModel: "gpt-5"
    },
    request: {
      model: "large-reasoning-model",
      schemaName: "planner_v1",
      systemPrompt: "Return planner JSON.",
      userPrompt: "Plan a safe next step.",
      temperature: 0
    },
    abortSignal: abortController.signal,
    includeTemperature: false,
    structuredOutputMode: "json_schema"
  });

  const body = JSON.parse(String(requestBuild.requestInit.body)) as {
    model?: string;
    input?: Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
    text?: { format?: { type?: string; name?: string; strict?: boolean } };
    reasoning?: { effort?: string };
    temperature?: unknown;
  };

  assert.equal(requestBuild.path, "/responses");
  assert.equal(body.model, "gpt-5");
  assert.equal(body.text?.format?.type, "json_schema");
  assert.equal(body.text?.format?.name, "planner_v1");
  assert.equal(body.text?.format?.strict, true);
  assert.equal(body.input?.[0]?.role, "system");
  assert.equal(body.input?.[1]?.role, "user");
  assert.equal(body.input?.[0]?.content?.[0]?.type, "input_text");
  assert.equal(body.reasoning?.effort, "minimal");
  assert.equal(body.temperature, undefined);
});

test("buildOpenAIResponsesRequest can degrade to json_object mode", () => {
  const abortController = new AbortController();
  const requestBuild = buildOpenAIResponsesRequest({
    apiKey: "test-key",
    model: {
      requestedModel: "large-reasoning-model",
      aliasModel: "large-reasoning-model",
      providerModel: "gpt-5"
    },
    request: {
      model: "large-reasoning-model",
      schemaName: "planner_v1",
      systemPrompt: "Return planner JSON.",
      userPrompt: "Plan a safe next step.",
      temperature: 0
    },
    abortSignal: abortController.signal,
    includeTemperature: false,
    structuredOutputMode: "json_object"
  });

  const body = JSON.parse(String(requestBuild.requestInit.body)) as {
    text?: { format?: { type?: string } };
  };

  assert.equal(body.text?.format?.type, "json_object");
  assert.equal(requestBuild.structuredOutputModeUsed, "json_object");
});

test("buildOpenAIResponsesRequest sets lower-latency reasoning effort per GPT-5 model variant", () => {
  const abortController = new AbortController();
  const expectations = [
    { providerModel: "gpt-5", expectedEffort: "minimal" },
    { providerModel: "gpt-5.1", expectedEffort: "none" },
    { providerModel: "gpt-5.2", expectedEffort: "none" },
    { providerModel: "gpt-5.3-codex", expectedEffort: "low" },
    { providerModel: "gpt-5-mini", expectedEffort: "low" },
    { providerModel: "gpt-4.1", expectedEffort: null }
  ] as const;

  for (const expectation of expectations) {
    const requestBuild = buildOpenAIResponsesRequest({
      apiKey: "test-key",
      model: {
        requestedModel: "large-reasoning-model",
        aliasModel: "large-reasoning-model",
        providerModel: expectation.providerModel
      },
      request: {
        model: "large-reasoning-model",
        schemaName: "planner_v1",
        systemPrompt: "Return planner JSON.",
        userPrompt: "Plan a safe next step.",
        temperature: 0
      },
      abortSignal: abortController.signal,
      includeTemperature: false,
      structuredOutputMode: "json_schema"
    });

    const body = JSON.parse(String(requestBuild.requestInit.body)) as {
      reasoning?: { effort?: string };
    };

    assert.equal(body.reasoning?.effort ?? null, expectation.expectedEffort, expectation.providerModel);
  }
});
